"""
Video AI Orchestrator (VAIO) — Lambda API Handler
=================================================
Backend for the guided storyboard-to-video wizard.

The whole surface is bilingual: a project is created in either English or French,
and every generated artefact (character bible, shot titles, narration, progress
detail shown in the console) is produced in that language.

Image-generation prompts are the deliberate exception — they are always emitted in
English, because the image models follow English prompts markedly more reliably.
See the LANGUAGE SUPPORT section for how that boundary is enforced.
"""

import base64
import io
import json
import logging
import os
import re
import uuid
from datetime import datetime, timezone

import boto3
from botocore.exceptions import ClientError
from botocore.config import Config as BotoConfig

logger = logging.getLogger()
logger.setLevel(logging.INFO)

# ─── Config ───
SERVICE_NAME = "vaio"
ASSETS_BUCKET = os.environ["ASSETS_BUCKET"]

# Opus 5 handles the creative, language-sensitive generation.
CLAUDE_MODEL_ID = os.environ.get("CLAUDE_MODEL_ID", "us.anthropic.claude-opus-5")
# Sonnet 5 handles short mechanical calls (prompt translation, style condensation).
CLAUDE_FAST_MODEL_ID = os.environ.get("CLAUDE_FAST_MODEL_ID", "us.anthropic.claude-sonnet-5")
CLAUDE_REGION = os.environ.get("CLAUDE_REGION", "us-east-1")
SD35_REGION = os.environ.get("SD35_REGION", "us-west-2")
MERGE_FUNCTION_NAME = os.environ.get("MERGE_FUNCTION_NAME", "")
DEFAULT_LANGUAGE = os.environ.get("DEFAULT_LANGUAGE", "en")

# Long-running work is handed off by invoking this same function asynchronously,
# which keeps the caller inside API Gateway's 29-second response window.
SELF_FUNCTION_NAME = os.environ.get("AWS_LAMBDA_FUNCTION_NAME", f"{SERVICE_NAME}-api")

# ─── Nova Sonic capacity ───
# Nova 2 Sonic's documented maximum output is 64K tokens. For a speech model the output
# budget covers generated audio, so this bounds how much narration a single session can
# speak.
NOVA_SONIC_MAX_OUTPUT_TOKENS = 64000

# Words per synthesis session. Narration longer than this is split across sessions and
# the audio concatenated.
#
# Set conservatively rather than pushed to the limit. The previous value of 1100 words
# meant a 3.5-minute video (roughly 500-600 words) was never split, and instead ran into
# the per-session output cap and was silently truncated part-way through. Truncated
# narration is a far worse outcome than an audible seam at a sentence boundary, and
# _chunk_text_for_tts only splits between sentences.
NOVA_SONIC_SESSION_WORD_LIMIT = 200

# SSM SecureString holding the Gemini API key. Read lazily and cached for the life
# of the execution environment, so the secret never sits in a Lambda environment
# variable or in source control.
GEMINI_KEY_PARAM = os.environ.get("GEMINI_KEY_PARAM", "/vaio/gemini-api-key")

s3 = boto3.client("s3", region_name="us-east-1", config=BotoConfig(signature_version="s3v4"))
bedrock = boto3.client("bedrock-runtime", region_name=CLAUDE_REGION, config=BotoConfig(read_timeout=300, max_pool_connections=10))
bedrock_west = boto3.client("bedrock-runtime", region_name=SD35_REGION, config=BotoConfig(read_timeout=300))
polly = boto3.client("polly", region_name="us-east-1")
lambda_client = boto3.client("lambda")
ssm = boto3.client("ssm", region_name=CLAUDE_REGION)

_gemini_api_key_cache = None


def get_gemini_api_key():
    """Return the Gemini API key from SSM, cached per execution environment.

    Returns:
        The decrypted API key, or an empty string when the parameter is missing or
        unreadable. Callers treat an empty key as "Gemini image generation is
        unavailable" and fall back to another model.
    """
    global _gemini_api_key_cache
    if _gemini_api_key_cache is not None:
        return _gemini_api_key_cache

    # Direct env override exists for local testing without SSM access.
    direct = os.environ.get("GEMINI_API_KEY", "")
    if direct:
        _gemini_api_key_cache = direct
        return _gemini_api_key_cache

    try:
        response = ssm.get_parameter(Name=GEMINI_KEY_PARAM, WithDecryption=True)
        _gemini_api_key_cache = response["Parameter"]["Value"]
    except ClientError as exc:
        code = exc.response.get("Error", {}).get("Code", "Unknown")
        logger.error(
            f"Could not read the Gemini API key from SSM parameter {GEMINI_KEY_PARAM} ({code}). "
            "Gemini image generation will be unavailable."
        )
        _gemini_api_key_cache = ""
    return _gemini_api_key_cache


# ═══════════════════════════════════════════════════════════════
# HELPERS
# ═══════════════════════════════════════════════════════════════

def respond(code, body):
    return {
        "statusCode": code,
        "headers": {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Headers": "Content-Type,Authorization,X-Amz-Date,X-Api-Key",
            "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
        },
        "body": json.dumps(body) if isinstance(body, (dict, list)) else body,
    }


def parse_json_body(event):
    body = event.get("body", "{}")
    if event.get("isBase64Encoded"):
        body = base64.b64decode(body).decode("utf-8")
    if isinstance(body, str):
        try:
            return json.loads(body)
        except json.JSONDecodeError:
            return {}
    return body or {}


def parse_multipart(event):
    """Parse multipart/form-data from API Gateway. Returns (file_bytes, filename, content_type)."""
    content_type = ""
    for k, v in (event.get("headers") or {}).items():
        if k.lower() == "content-type":
            content_type = v
            break

    body_raw = event.get("body", "")
    if event.get("isBase64Encoded"):
        body_bytes = base64.b64decode(body_raw)
    elif isinstance(body_raw, str):
        # With multipart/form-data in binaryMediaTypes, this shouldn't happen
        # but handle it as a fallback — try base64 first
        try:
            decoded = base64.b64decode(body_raw)
            if decoded[:2] == b"--":
                body_bytes = decoded
            else:
                body_bytes = body_raw.encode("utf-8", errors="replace")
        except Exception:
            body_bytes = body_raw.encode("utf-8", errors="replace")
    else:
        body_bytes = body_raw

    # Extract boundary
    boundary_match = re.search(r"boundary=([^\s;]+)", content_type)
    if not boundary_match:
        logger.error(f"No boundary found in content-type: {content_type}")
        return None, None, None

    boundary = boundary_match.group(1).strip().strip('"')
    delimiter = f"--{boundary}".encode()
    end_delimiter = f"--{boundary}--".encode()

    # Split on boundary
    parts = body_bytes.split(delimiter)

    for part in parts:
        if not part or part.strip() == b"" or part.strip() == b"--":
            continue

        # Find the header/body separator (double CRLF)
        sep_idx = part.find(b"\r\n\r\n")
        if sep_idx == -1:
            continue

        headers_raw = part[:sep_idx].decode("utf-8", errors="replace")
        body_data = part[sep_idx + 4:]

        # Check if this part has a filename (i.e., it's a file upload)
        fn_match = re.search(r'filename="([^"]*)"', headers_raw)
        if not fn_match:
            continue

        filename = fn_match.group(1)

        # Strip trailing CRLF and end boundary
        if body_data.endswith(b"\r\n"):
            body_data = body_data[:-2]

        # Get content type of this part
        ct_match = re.search(r"Content-Type:\s*(.+?)(?:\r\n|\r|\n|$)", headers_raw)
        ct = ct_match.group(1).strip() if ct_match else "application/octet-stream"

        logger.info(f"Parsed multipart file: {filename}, size={len(body_data)}, ct={ct}")
        return body_data, filename, ct

    logger.error(f"No file part found in multipart body (boundary={boundary}, body_size={len(body_bytes)})")
    return None, None, None


def is_multipart(event):
    ct = ""
    for k, v in (event.get("headers") or {}).items():
        if k.lower() == "content-type":
            ct = v.lower()
            break
    return "multipart/form-data" in ct


def path_param(event, name):
    # Try API Gateway path parameters first
    params = event.get("pathParameters") or {}
    if name in params:
        return params[name]
    # With {proxy+} routing, extract from the path manually
    # e.g., /api/voice-sample/tiffany -> voice_id = "tiffany"
    path = event.get("path", "")
    path = re.sub(r"^/prod", "", path)  # strip stage
    # Match against known patterns
    patterns = {
        "voice_id": r"/api/(?:voice-sample|play-voice-sample)/([^/]+)",
        "job_id": r"/api/(?:video-status|download-video|preview-video|script-status|approve-characters)/([^/]+)",
        "run_id": r"/api/(?:runs|run-image)/([^/]+)",
        "filename": r"/api/(?:preview-music|run-image/[^/]+)/([^/]+)$",
        "source": r"/api/preview-wallpaper/([^/]+)/",
    }
    if name in patterns:
        m = re.search(patterns[name], path)
        if m:
            return m.group(1)
    # Generic: last path segment
    parts = [p for p in path.split("/") if p]
    if name == "filename" and len(parts) >= 1:
        return parts[-1]
    return None


def s3_put(key, data, content_type="application/octet-stream"):
    s3.put_object(Bucket=ASSETS_BUCKET, Key=key, Body=data, ContentType=content_type)


def s3_get(key):
    resp = s3.get_object(Bucket=ASSETS_BUCKET, Key=key)
    return resp["Body"].read(), resp["ContentType"]


def s3_exists(key):
    try:
        s3.head_object(Bucket=ASSETS_BUCKET, Key=key)
        return True
    except ClientError:
        return False


def s3_list(prefix):
    result = []
    paginator = s3.get_paginator("list_objects_v2")
    for page in paginator.paginate(Bucket=ASSETS_BUCKET, Prefix=prefix):
        for obj in page.get("Contents", []):
            result.append(obj)
    return result


def s3_delete_prefix(prefix):
    objects = s3_list(prefix)
    if objects:
        s3.delete_objects(Bucket=ASSETS_BUCKET, Delete={"Objects": [{"Key": o["Key"]} for o in objects]})


def presigned_url(key, expires=43200):
    # Default 12-hour expiry so storyboard assets don't vanish when the user
    # steps away from the app for a while.
    return s3.generate_presigned_url("get_object", Params={"Bucket": ASSETS_BUCKET, "Key": key}, ExpiresIn=expires)


def call_claude(system_prompt, user_message, max_tokens=4096, fast=False):
    """Invoke Claude through the Bedrock Converse API.

    Args:
        system_prompt: System instructions for the model.
        user_message: The user turn content.
        max_tokens: Output token ceiling.
        fast: Route to the cheaper, faster model. Use for short mechanical work
            such as translation or style condensation.

    Returns:
        The model response text.

    Raises:
        ClientError: If Bedrock rejects the request.
    """
    # Claude 5 rejects `temperature` in inferenceConfig, so only maxTokens is set.
    response = bedrock.converse(
        modelId=CLAUDE_FAST_MODEL_ID if fast else CLAUDE_MODEL_ID,
        system=[{"text": system_prompt}],
        messages=[{"role": "user", "content": [{"text": user_message}]}],
        inferenceConfig={"maxTokens": max_tokens},
    )
    return extract_converse_text(response)


def extract_converse_text(response):
    """Pull the assistant's text out of a Bedrock Converse response.

    Claude 5 models emit a `reasoningContent` block ahead of the `text` block, so
    indexing content[0] returns the reasoning wrapper and raises KeyError. This
    scans for the first block that actually carries text and concatenates any
    further text blocks.

    Args:
        response: Raw response dict from bedrock.converse.

    Returns:
        The concatenated assistant text.

    Raises:
        ValueError: If the response contains no text block at all.
    """
    blocks = response.get("output", {}).get("message", {}).get("content", []) or []
    texts = [block["text"] for block in blocks if isinstance(block, dict) and "text" in block]
    if not texts:
        block_shapes = [list(block.keys()) for block in blocks if isinstance(block, dict)]
        raise ValueError(
            f"Converse response contained no text block (stopReason="
            f"{response.get('stopReason')}, blocks={block_shapes})"
        )
    return "".join(texts)


def now_iso():
    return datetime.now(timezone.utc).isoformat()


# ═══════════════════════════════════════════════════════════════
# LANGUAGE SUPPORT
# ═══════════════════════════════════════════════════════════════
# A project is authored in exactly one language. That single choice drives three
# things which are deliberately kept separate:
#
#   1. Generation language — what Claude writes character bibles, shot titles and
#      narration in. Follows the project language.
#   2. Prompt language — always English. Image models (Gemini/Nano Banana Pro,
#      Nova Canvas, SD3.5) follow English prompts far more reliably, so French
#      projects have their image prompts translated before dispatch.
#   3. Speech language — the Nova Sonic voice and its Polly fallback must match
#      the narration language, or the text is read with the wrong phonetics.

SUPPORTED_LANGUAGES = ("en", "fr")

# English names, used inside prompts addressed to the model.
LANGUAGE_NAMES = {"en": "English", "fr": "French"}

# Amazon Transcribe locale used when re-voicing an uploaded video.
TRANSCRIBE_LANGUAGE_CODES = {"en": "en-US", "fr": "fr-CA"}

# Nova Sonic voice catalog, grouped by project language.
#
# tiffany and matthew are polyglot voices — they speak French natively as well as
# English — so they appear in both lists. ambre and florian are the dedicated
# fr-FR voices. Each entry carries the Polly voice to use if Nova Sonic fails;
# Polly has no fr-FR generative voice, so French falls back to fr-CA.
VOICE_CATALOG = {
    "en": [
        {"id": "tiffany", "name": "Tiffany", "gender": "F", "polly": "Tiffany"},
        {"id": "matthew", "name": "Matthew", "gender": "M", "polly": "Matthew"},
        {"id": "amy", "name": "Amy", "gender": "F", "polly": "Joanna"},
    ],
    "fr": [
        {"id": "ambre", "name": "Ambre", "gender": "F", "polly": "Gabrielle"},
        {"id": "florian", "name": "Florian", "gender": "M", "polly": "Liam"},
        {"id": "tiffany", "name": "Tiffany", "gender": "F", "polly": "Gabrielle"},
        {"id": "matthew", "name": "Matthew", "gender": "M", "polly": "Liam"},
    ],
}

# Voice descriptions, keyed by interface language then voice id.
VOICE_DESCRIPTIONS = {
    "en": {
        "tiffany": "Female, friendly and warm",
        "matthew": "Male, professional and clear",
        "amy": "Female, lively and energetic",
        "ambre": "Female, warm French voice",
        "florian": "Male, clear French voice",
    },
    "fr": {
        "ambre": "Voix féminine française, chaleureuse",
        "florian": "Voix masculine française, claire",
        "tiffany": "Voix féminine polyglotte, chaleureuse",
        "matthew": "Voix masculine polyglotte, professionnelle",
        "amy": "Voix féminine anglaise, dynamique",
    },
}

# Voice-preview script, per language.
VOICE_SAMPLE_TEXT = {
    "en": "Hi, I'm {name}. Let's make a video together.",
    "fr": "Bonjour, je m'appelle {name}. Créons une vidéo ensemble.",
}

# Progress messages written by the backend into job status. These surface
# verbatim in the console, so they have to be localized here rather than in the
# frontend. Keys are stable identifiers; values are format templates.
STATUS_MESSAGES = {
    "en": {
        "queued": "Analyzing script and extracting characters…",
        "analyzing_script": "Analyzing script — identifying characters…",
        "storing_references": "Storing {count} reference image(s)…",
        "generating_refs": "Generating character sheet and style reference ({count} characters)…",
        "generating_portraits": "Generating {count} character portraits…",
        "generating_style_ref": "Generating style reference…",
        "characters_found": "Found {count} characters. Generating {shots} shot prompts…",
        "characters_ready": "Found {count} characters. Review and approve to continue.",
        "characters_approved_regen": "Characters approved. Regenerating the character sheet with your updated descriptions…",
        "characters_approved": "Characters approved. Generating shot prompts…",
        "generating_shots": "Generating {count} shot prompts…",
        "translating_prompts": "Preparing English image prompts…",
        "complete": "Generated {shots} shots with {characters} consistent characters",
        "generating_audio": "Generating voice-over…",
        "merging": "Merging video and audio…",
    },
    "fr": {
        "queued": "Analyse du scénario et extraction des personnages…",
        "analyzing_script": "Analyse du scénario — identification des personnages…",
        "storing_references": "Enregistrement de {count} image(s) de référence…",
        "generating_refs": "Création de la fiche des personnages et de la référence de style ({count} personnages)…",
        "generating_portraits": "Création de {count} portraits de personnages…",
        "generating_style_ref": "Création de la référence de style…",
        "characters_found": "{count} personnages trouvés. Création de {shots} plans…",
        "characters_ready": "{count} personnages trouvés. Vérifiez et approuvez pour continuer.",
        "characters_approved_regen": "Personnages approuvés. Régénération de la fiche avec vos descriptions mises à jour…",
        "characters_approved": "Personnages approuvés. Création des plans…",
        "generating_shots": "Création de {count} plans…",
        "translating_prompts": "Préparation des prompts d'image en anglais…",
        "complete": "{shots} plans générés avec {characters} personnages cohérents",
        "generating_audio": "Génération de la voix hors champ…",
        "merging": "Fusion de la vidéo et de l'audio…",
    },
}


def normalize_language(value):
    """Coerce arbitrary input into a supported language code.

    Accepts codes and locales such as "fr", "FR", "fr-CA", "french" or "français"
    and falls back to DEFAULT_LANGUAGE for anything unrecognized, so a malformed
    request degrades rather than failing.

    Args:
        value: Candidate language value from a request body or a stored manifest.

    Returns:
        Either "en" or "fr".
    """
    fallback = DEFAULT_LANGUAGE if DEFAULT_LANGUAGE in SUPPORTED_LANGUAGES else "en"
    if not value:
        return fallback

    candidate = str(value).strip().lower()
    if candidate in SUPPORTED_LANGUAGES:
        return candidate

    # Locale forms such as fr-CA, fr_FR, en-GB.
    prefix = re.split(r"[-_]", candidate)[0]
    if prefix in SUPPORTED_LANGUAGES:
        return prefix

    if candidate in ("french", "francais", "français"):
        return "fr"
    if candidate in ("english", "anglais"):
        return "en"

    logger.warning(f"Unrecognized language '{value}' — falling back to '{fallback}'")
    return fallback


def status_message(key, language, **kwargs):
    """Return a localized backend progress message.

    Args:
        key: Identifier from STATUS_MESSAGES.
        language: Target language code.
        **kwargs: Format arguments for the template.

    Returns:
        The formatted localized string. Falls back to English, then to the raw
        key, so an unknown identifier never raises.
    """
    language = normalize_language(language)
    template = STATUS_MESSAGES.get(language, {}).get(key)
    if template is None:
        template = STATUS_MESSAGES["en"].get(key, key)
    try:
        return template.format(**kwargs)
    except (KeyError, IndexError):
        return template


def language_directive(language):
    """Build the system-prompt clause that pins Claude's output language.

    Args:
        language: Target language code.

    Returns:
        A directive to append to a system prompt. Empty for English, since the
        models already default to it and the extra instruction is only noise.
    """
    if normalize_language(language) == "en":
        return ""
    return (
        "\n═══ OUTPUT LANGUAGE — FRENCH ═══\n"
        "Write ALL human-readable output in FRENCH (français): shot titles, narration "
        "text, and character descriptions.\n"
        "Use natural, idiomatic, professional French — not a word-for-word rendering of "
        "English phrasing. Apply French typographic convention: a space before : ; ! and ?, "
        "and « » for quotation marks.\n"
        "Keep character NAMES exactly as they appear in the script. Do not translate proper "
        "nouns, brand names, or place names.\n"
        "CRITICAL EXCEPTION: the \"image_prompt\" field must ALWAYS be written in ENGLISH. "
        "It is sent to an image-generation model that performs poorly with French. Every "
        "other field is French.\n"
    )


def resolve_voice(voice_id, language):
    """Resolve a requested voice to a valid entry for the given language.

    Args:
        voice_id: Requested Nova Sonic voice id.
        language: Project language code.

    Returns:
        A VOICE_CATALOG entry. Falls back to the language's first voice when the
        requested id is not valid for that language — for example a French project
        whose manifest still carries "amy", which is English-only.
    """
    catalog = VOICE_CATALOG[normalize_language(language)]
    for voice in catalog:
        if voice["id"] == voice_id:
            return voice
    logger.info(
        f"Voice '{voice_id}' is unavailable for '{language}' — using '{catalog[0]['id']}' instead"
    )
    return catalog[0]


def looks_like_french(text):
    """Heuristic test for whether text is French rather than English.

    Used to avoid a pointless translation round trip on prompts a model already
    emitted in English. Accented characters are the cheapest strong signal;
    common function words cover unaccented French.

    Args:
        text: Text to inspect.

    Returns:
        True if the text appears to be French.
    """
    if re.search(r"[àâäçéèêëîïôöùûüÿœæÀÂÄÇÉÈÊËÎÏÔÖÙÛÜŸŒÆ]", text):
        return True
    padded = f" {text.lower()} "
    function_words = (" le ", " la ", " les ", " des ", " une ", " un ", " dans ",
                      " avec ", " sur ", " qui ", " est ", " et ", " du ", " au ")
    return sum(1 for word in function_words if word in padded) >= 2


def translate_prompt_to_english(prompt, language):
    """Translate an image prompt into English when needed.

    Image models follow English prompts markedly more reliably, so French projects
    translate before dispatch. The translation preserves structure and ordering
    rather than paraphrasing, because shot-to-shot visual consistency depends on
    the style prefix staying identical across every prompt.

    Args:
        prompt: The image prompt, possibly in French.
        language: The project language code.

    Returns:
        The English prompt. Returns the input unchanged for English projects, for
        empty input, or if translation fails — a prompt in the wrong language still
        produces an image, whereas raising here would abort the whole shot.
    """
    if not prompt or not prompt.strip():
        return prompt
    if normalize_language(language) == "en":
        return prompt
    if not looks_like_french(prompt):
        return prompt

    system = (
        "You translate image-generation prompts from French to English.\n"
        "RULES:\n"
        "- Output ONLY the translated prompt. No preamble, no quotes, no explanation.\n"
        "- Preserve the exact structure, clause ordering, and comma separation.\n"
        "- Keep any leading style tag as the first clause.\n"
        "- Use standard English image-prompt vocabulary for camera and lighting terms "
        "(for example 'plan rapproché' becomes 'medium shot', 'lumière dorée' becomes "
        "'warm golden light').\n"
        "- Keep proper nouns (character, place, and brand names) unchanged.\n"
        "- Do not add, remove, or embellish any detail."
    )
    try:
        cleaned = call_claude(system, prompt, max_tokens=800, fast=True).strip().strip('"').strip("'")
        if cleaned:
            return cleaned
        logger.warning("Prompt translation returned empty output — keeping the original prompt")
    except ClientError as exc:
        code = exc.response.get("Error", {}).get("Code", "Unknown")
        logger.warning(f"Prompt translation failed ({code}) — keeping the original prompt")
    except Exception as exc:  # noqa: BLE001 — translation must never abort a shot
        logger.warning(f"Prompt translation failed ({type(exc).__name__}) — keeping the original prompt")
    return prompt


def translate_characters_to_english(characters, language):
    """Produce English character descriptions for use in image prompts.

    Character descriptions are shown to the user and are editable, so they are
    generated in the project language. Image models need them in English. Both
    versions are kept: the project-language one for the UI, this one for prompts.

    The whole set is translated in a single call so the model keeps terminology
    consistent between characters, which matters because these descriptions are
    pasted verbatim into every shot prompt.

    Args:
        characters: Mapping of character name to description.
        language: Project language code.

    Returns:
        Mapping of character name to English description. Returns the input
        unchanged for English projects, or on any translation failure.
    """
    if not characters:
        return {}
    if normalize_language(language) == "en":
        return dict(characters)
    if not any(looks_like_french(desc) for desc in characters.values() if desc):
        return dict(characters)

    system = (
        "You translate character design descriptions from French to English for use in "
        "image-generation prompts.\n"
        "RULES:\n"
        "- Return ONLY a JSON object mapping the original character name to the English "
        "description. No markdown, no code fences, no commentary.\n"
        "- Keep character names EXACTLY as given, including accents. Do not translate names.\n"
        "- Keep each description as ONE dense line, preserving every visual detail: hair, "
        "eyes, skin or surface, age, build, clothing, distinguishing features.\n"
        "- Use standard English colour and garment vocabulary.\n"
        "- Do not add, drop, or embellish any detail."
    )
    try:
        raw = call_claude(system, json.dumps(characters, ensure_ascii=False), max_tokens=3000, fast=True)
        match = re.search(r"\{[\s\S]*\}", raw)
        if not match:
            logger.warning("Character translation returned no JSON object — keeping originals")
            return dict(characters)

        translated = json.loads(match.group())
        # Only accept the translation if every character survived the round trip;
        # a partial map would silently drop characters from later shot prompts.
        missing = set(characters) - set(translated)
        if missing:
            logger.warning(f"Character translation dropped {sorted(missing)} — keeping originals")
            return dict(characters)

        return {name: str(translated[name]) for name in characters}
    except (ClientError, json.JSONDecodeError) as exc:
        logger.warning(f"Character translation failed ({type(exc).__name__}) — keeping originals")
    except Exception as exc:  # noqa: BLE001 — must never abort script processing
        logger.warning(f"Character translation failed ({type(exc).__name__}) — keeping originals")
    return dict(characters)


def get_run_language(run_id):
    """Look up the language a run was created in.

    Args:
        run_id: The run identifier.

    Returns:
        The stored language code, or DEFAULT_LANGUAGE when the manifest is absent
        or predates language tracking.
    """
    if not run_id:
        return normalize_language(DEFAULT_LANGUAGE)

    manifest_key = f"runs/{run_id}/manifest.json"
    if not s3_exists(manifest_key):
        return normalize_language(DEFAULT_LANGUAGE)
    try:
        data, _ = s3_get(manifest_key)
        return normalize_language(json.loads(data).get("language"))
    except (ClientError, json.JSONDecodeError, KeyError) as exc:
        logger.warning(f"Could not read the language for run {run_id}: {type(exc).__name__}")
        return normalize_language(DEFAULT_LANGUAGE)


# ═══════════════════════════════════════════════════════════════
# NOVA SONIC TTS
# ═══════════════════════════════════════════════════════════════

async def nova_sonic_synthesize(text, voice_id, region="us-east-1", language="en"):
    """Synthesize speech using Amazon Nova Sonic via bidirectional streaming.

    Args:
        text: Narration to read aloud.
        voice_id: Nova Sonic voice id, already validated for the language.
        region: Bedrock region hosting Nova Sonic.
        language: Project language code. Drives the language of the system prompt
            and read instruction, which keeps the model from switching to English
            or adding an English preamble to French narration.

    Returns:
        Raw 24 kHz mono 16-bit PCM bytes, or None when no audio was produced.
    """
    import asyncio
    from aws_sdk_bedrock_runtime.client import (
        BedrockRuntimeClient,
        InvokeModelWithBidirectionalStreamOperationInput,
    )
    from aws_sdk_bedrock_runtime.config import Config
    from aws_sdk_bedrock_runtime.models import (
        BidirectionalInputPayloadPart,
        InvokeModelWithBidirectionalStreamInputChunk,
    )

    # Lambda uses IAM role credentials automatically
    import boto3
    session = boto3.Session()
    creds = session.get_credentials().get_frozen_credentials()

    from smithy_aws_core.identity.static import StaticCredentialsResolver
    config = Config(
        endpoint_uri=f"https://bedrock-runtime.{region}.amazonaws.com",
        region=region,
        aws_credentials_identity_resolver=StaticCredentialsResolver(),
        aws_access_key_id=creds.access_key,
        aws_secret_access_key=creds.secret_key,
        aws_session_token=creds.token,
    )
    client = BedrockRuntimeClient(config=config)

    prompt_name = str(uuid.uuid4())
    sys_name = str(uuid.uuid4())
    audio_name = str(uuid.uuid4())
    text_input_name = str(uuid.uuid4())

    async def send(stream, evt):
        await stream.input_stream.send(
            InvokeModelWithBidirectionalStreamInputChunk(
                value=BidirectionalInputPayloadPart(bytes_=json.dumps(evt).encode("utf-8"))
            )
        )

    bidi = await client.invoke_model_with_bidirectional_stream(
        InvokeModelWithBidirectionalStreamOperationInput(model_id="amazon.nova-2-sonic-v1:0")
    )

    audio_chunks = []  # final audio (the first complete reading)
    done = asyncio.Event()
    # Set on the first audioOutput. Used to stop feeding keep-alive silence, which is
    # what stops the model taking a second turn and re-reading the text.
    audio_started = asyncio.Event()
    # Tracks whether keep_alive already closed the audio content block, so the teardown
    # below does not close it twice.
    audio_content_closed = False
    # Assistant transcript, accumulated so a repeat can be detected as observed fact
    # rather than inferred from how long the audio turned out to be.
    transcript_parts = []

    async def collect_responses():
        # Termination signals, in priority order:
        #   1. END_TURN contentEnd  -> the model is definitively finished speaking.
        #   2. Audio idle timeout   -> no audioOutput for a while after audio started
        #      (covers a slow or absent END_TURN).
        #
        # The TEXT transcript streams AHEAD of the audio, so transcript coverage is not
        # used to stop collection: cutting there would clip the tail of the reading.
        # It is recorded instead, and used afterwards to establish how many times the
        # model actually read the text.
        got_audio = False
        last_audio_time = None
        AUDIO_IDLE_STOP = 8.0  # seconds of audio silence => reading finished

        try:
            while not done.is_set():
                try:
                    output = await asyncio.wait_for(bidi.await_output(), timeout=2)
                    result = await output[1].receive()
                    if not (result.value and result.value.bytes_):
                        continue
                    data = json.loads(result.value.bytes_.decode("utf-8"))
                    if "event" not in data:
                        continue
                    evt = data["event"]

                    if "audioOutput" in evt:
                        audio_chunks.append(base64.b64decode(evt["audioOutput"]["content"]))
                        got_audio = True
                        audio_started.set()
                        last_audio_time = asyncio.get_event_loop().time()
                    elif "textOutput" in evt:
                        # Only the model's own speech transcript matters here; the echo
                        # of the user turn would otherwise count as a reading.
                        payload = evt["textOutput"]
                        if str(payload.get("role", "")).upper() != "USER":
                            transcript_parts.append(payload.get("content", ""))
                    elif "contentEnd" in evt:
                        if evt["contentEnd"].get("stopReason") == "END_TURN":
                            done.set()
                            return
                except asyncio.TimeoutError:
                    # No event for 2s — if audio has been flowing and then went idle
                    # for a while, the reading is complete.
                    if got_audio and last_audio_time is not None:
                        idle = asyncio.get_event_loop().time() - last_audio_time
                        if idle >= AUDIO_IDLE_STOP:
                            logger.info(f"Nova Sonic: audio idle {idle:.1f}s — assuming read complete")
                            done.set()
                            return
                    continue
        except Exception as e:
            logger.error(f"Nova Sonic response error: {e}")
            done.set()

    response_task = asyncio.create_task(collect_responses())

    # Session start
    await send(bidi, {"event": {"sessionStart": {"inferenceConfiguration": {
        # 64K is Nova 2 Sonic's documented maximum output. For a speech model the
        # output budget covers the generated audio, so this is a hard ceiling on how
        # much narration one session can speak, and the previous 32000 truncated long
        # reads around the 90-second mark with no error. Long narration is additionally
        # split across sessions (see NOVA_SONIC_SESSION_WORD_LIMIT) so no single session
        # ever approaches this bound.
        "maxTokens": NOVA_SONIC_MAX_OUTPUT_TOKENS, "topP": 0.9, "temperature": 0.7,
    }}}})

    # Prompt start
    await send(bidi, {"event": {"promptStart": {
        "promptName": prompt_name,
        "textOutputConfiguration": {"mediaType": "text/plain"},
        "audioOutputConfiguration": {
            "mediaType": "audio/lpcm", "sampleRateHertz": 24000,
            "sampleSizeBits": 16, "channelCount": 1,
            "voiceId": voice_id, "encoding": "base64", "audioType": "SPEECH",
        },
    }}})

    # System prompt — force exactly one reading, then an immediate end of turn.
    #
    # Nova Sonic is a conversational speech-to-speech model being driven as a TTS
    # engine, so it has a standing tendency to keep talking: acknowledge, read, then
    # read again. French was reliably doubling because the earlier wording buried the
    # stop condition in prose.
    #
    # Two things make the stop authoritative rather than advisory:
    #   1. The text to read is delimited by explicit tags, so "where the text ends" is
    #      unambiguous instead of inferred from punctuation.
    #   2. The rules are numbered and the stop is its own rule, phrased as an action
    #      taken the instant the final word is spoken.
    #
    # For French the instruction is written in French. The polyglot voices otherwise
    # drift toward English pronunciation or prepend an English acknowledgement.
    language = normalize_language(language)
    if language == "fr":
        system_text = (
            "Tu es un MOTEUR DE SYNTHÈSE VOCALE, pas un assistant conversationnel.\n"
            "RÈGLES ABSOLUES :\n"
            "1. Tu lis à voix haute, en français, UNIQUEMENT le texte placé entre les balises "
            "<TEXTE> et </TEXTE>.\n"
            "2. Tu le lis UNE SEULE FOIS, du début à la fin, mot pour mot.\n"
            "3. Dès que tu as prononcé le DERNIER MOT, tu TERMINES ton tour IMMÉDIATEMENT. "
            "Tu ne produis plus aucun son après ce dernier mot.\n"
            "4. Tu ne répètes JAMAIS le texte, ni en entier, ni en partie, sous aucun prétexte.\n"
            "5. Tu ne dis rien d'autre : aucune salutation, aucun commentaire, aucune "
            "confirmation, aucune question, aucun mot avant ou après.\n"
            "6. Tu ne prononces pas les balises <TEXTE> et </TEXTE> elles-mêmes.\n"
            "7. Tu ne traduis pas et tu ne reformules pas : tu lis le texte exactement "
            "tel qu'il est écrit, en français."
        )
        read_instruction = "<TEXTE>\n"
        read_closing = "\n</TEXTE>"
    else:
        system_text = (
            "You are a TEXT-TO-SPEECH ENGINE, not a conversational assistant.\n"
            "ABSOLUTE RULES:\n"
            "1. Read aloud, in English, ONLY the text placed between the <TEXT> and "
            "</TEXT> tags.\n"
            "2. Read it EXACTLY ONCE, start to finish, word for word.\n"
            "3. The instant you have spoken the LAST WORD, END your turn IMMEDIATELY. "
            "Produce no further audio after that last word.\n"
            "4. NEVER repeat the text, in whole or in part, for any reason.\n"
            "5. Say nothing else: no greeting, no commentary, no confirmation, no "
            "question, no words before or after.\n"
            "6. Do not speak the <TEXT> and </TEXT> tags themselves.\n"
            "7. Do not translate and do not rephrase: read the text exactly as written."
        )
        read_instruction = "<TEXT>\n"
        read_closing = "\n</TEXT>"
    await send(bidi, {"event": {"contentStart": {
        "promptName": prompt_name, "contentName": sys_name,
        "type": "TEXT", "interactive": True, "role": "SYSTEM",
        "textInputConfiguration": {"mediaType": "text/plain"},
    }}})
    await send(bidi, {"event": {"textInput": {
        "promptName": prompt_name, "contentName": sys_name, "content": system_text,
    }}})
    await send(bidi, {"event": {"contentEnd": {
        "promptName": prompt_name, "contentName": sys_name,
    }}})

    # Audio input (required for active session)
    await send(bidi, {"event": {"contentStart": {
        "promptName": prompt_name, "contentName": audio_name,
        "type": "AUDIO", "interactive": True, "role": "USER",
        "audioInputConfiguration": {
            "mediaType": "audio/lpcm", "sampleRateHertz": 16000,
            "sampleSizeBits": 16, "channelCount": 1,
            "audioType": "SPEECH", "encoding": "base64",
        },
    }}})

    # Cross-modal text input.
    # Nova Sonic limits a single textInput event to ~1KB, so long narration must be
    # sent as MULTIPLE textInput events within the SAME content block (one session,
    # one continuous read — no chunk seams that cause dropped/paraphrased words).
    await send(bidi, {"event": {"contentStart": {
        "promptName": prompt_name, "contentName": text_input_name,
        "type": "TEXT", "interactive": True, "role": "USER",
        "textInputConfiguration": {"mediaType": "text/plain"},
    }}})

    # First event: the instruction. Then the narration text in <=900-byte pieces,
    # split on whitespace so we never break inside a word.
    await send(bidi, {"event": {"textInput": {
        "promptName": prompt_name, "contentName": text_input_name,
        "content": read_instruction,
    }}})

    def _split_text_for_input(s, max_bytes=900):
        pieces, current = [], ""
        for word in s.split():
            candidate = (current + " " + word) if current else word
            if len(candidate.encode("utf-8")) > max_bytes and current:
                pieces.append(current)
                current = word
            else:
                current = candidate
        if current:
            pieces.append(current)
        return pieces

    for piece in _split_text_for_input(text):
        await send(bidi, {"event": {"textInput": {
            "promptName": prompt_name, "contentName": text_input_name,
            "content": piece + " ",
        }}})

    # Closing delimiter. This is what makes "the last word" unambiguous, so the model
    # has a definite point at which rule 3 (end the turn immediately) applies.
    await send(bidi, {"event": {"textInput": {
        "promptName": prompt_name, "contentName": text_input_name,
        "content": read_closing,
    }}})

    await send(bidi, {"event": {"contentEnd": {
        "promptName": prompt_name, "contentName": text_input_name,
    }}})

    # Keep-alive silence
    silence_chunk = base64.b64encode(b"\x00\x00" * 512).decode("utf-8")

    async def keep_alive():
        # The silence exists only to hold the session open until the model starts
        # speaking. It is USER audio, and Nova Sonic is a conversational model, so
        # continuing to feed it after the reading has begun reads as another user turn
        # ending and prompts a second reading of the same text. Stopping as soon as the
        # first audio arrives is what actually makes the model stop after one read;
        # prompt wording alone did not.
        while not done.is_set() and not audio_started.is_set():
            try:
                await send(bidi, {"event": {"audioInput": {
                    "promptName": prompt_name, "contentName": audio_name,
                    "content": silence_chunk,
                }}})
            except Exception:
                break
            await asyncio.sleep(0.1)

        # Close the user audio turn explicitly. Leaving it open is itself an invitation
        # for the model to keep going.
        if audio_started.is_set() and not done.is_set():
            try:
                await send(bidi, {"event": {"contentEnd": {
                    "promptName": prompt_name, "contentName": audio_name,
                }}})
                nonlocal audio_content_closed
                audio_content_closed = True
            except Exception:
                pass

    keepalive_task = asyncio.create_task(keep_alive())

    try:
        # A single session can stream up to ~8 minutes of audio; allow for that
        # plus headroom rather than cutting off long narration after 60s.
        await asyncio.wait_for(done.wait(), timeout=540)
    except asyncio.TimeoutError:
        logger.error("Nova Sonic timeout")

    keepalive_task.cancel()
    try:
        await keepalive_task
    except asyncio.CancelledError:
        pass

    if not response_task.done():
        response_task.cancel()
        try:
            await response_task
        except asyncio.CancelledError:
            pass

    try:
        if not audio_content_closed:
            await send(bidi, {"event": {"contentEnd": {"promptName": prompt_name, "contentName": audio_name}}})
        await send(bidi, {"event": {"promptEnd": {"promptName": prompt_name}}})
        await send(bidi, {"event": {"sessionEnd": {}}})
        await bidi.input_stream.close()
    except Exception:
        pass

    pcm = b"".join(audio_chunks)
    transcript = "".join(transcript_parts)
    return _drop_repeated_reading(pcm, text, transcript)


def _normalize_for_match(value):
    """Reduce text to comparable form: lowercase ASCII letters and digits only.

    Punctuation, spacing, casing, and accents all differ between the input text and the
    model's transcript even when the spoken words are identical. Accents matter most
    here: a transcript returning "reve" for an input "rêve" would otherwise look like a
    mismatch and let a genuine doubled French reading through undetected.

    Args:
        value: Text to normalize.

    Returns:
        A lowercase, accent-folded string of alphanumeric characters only.
    """
    import unicodedata

    # NFKD splits accented characters into base letter plus combining mark; dropping
    # the marks folds "rêve" and "reve" onto the same form.
    decomposed = unicodedata.normalize("NFKD", value or "")
    folded = "".join(ch for ch in decomposed if not unicodedata.combining(ch))
    return re.sub(r"[^0-9a-z]+", "", folded.lower())


def count_readings(text, transcript):
    """Count how many times the transcript contains the input text.

    This is the authoritative check for a doubled reading: it compares what the model
    said it spoke against what it was asked to speak. No audio duration is involved.

    Args:
        text: The text the model was asked to read.
        transcript: The model's own speech transcript.

    Returns:
        Number of complete readings found, or -1 when the comparison is not
        meaningful (empty input, or a transcript too short to judge).
    """
    normalized_text = _normalize_for_match(text)
    normalized_transcript = _normalize_for_match(transcript)
    if not normalized_text or not normalized_transcript:
        return -1

    # A partial transcript (the stream can be cut short) must not be read as zero
    # readings and trigger a needless cut.
    if len(normalized_transcript) < len(normalized_text):
        return -1

    count = 0
    start = 0
    while True:
        found = normalized_transcript.find(normalized_text, start)
        if found == -1:
            break
        count += 1
        start = found + len(normalized_text)
    return count


def _drop_repeated_reading(pcm, text, transcript):
    """Remove extra readings when the transcript proves the model repeated itself.

    The prompt instructs the model to read once and end its turn, and that is the real
    fix. This is a backstop for when it disobeys anyway, and it engages only on
    evidence: the transcript must contain the full text more than once.

    Deliberately NOT based on estimating how long the clip should have been. The
    previous implementation allowed up to 2.2x a word-count estimate, which let a
    doubled reading through untouched while risking clipping legitimate slow speech.

    When the transcript shows N identical readings by one voice at one speaking rate,
    the audio divides into N near-equal parts, so the first 1/N is kept.

    Args:
        pcm: Raw PCM audio for the whole turn.
        text: The text the model was asked to read.
        transcript: The model's speech transcript.

    Returns:
        PCM containing a single reading.
    """
    readings = count_readings(text, transcript)
    if readings <= 1:
        if readings == -1:
            logger.info("Nova Sonic: transcript unavailable for repeat check, keeping audio as received")
        return pcm

    sample_rate = 24000
    nominal = len(pcm) // readings
    keep = _find_silence_boundary(pcm, nominal, sample_rate)
    logger.warning(
        f"Nova Sonic read the text {readings}x despite the single-read instruction; "
        f"keeping the first reading ({len(pcm)/(sample_rate*2):.1f}s -> {keep/(sample_rate*2):.1f}s)"
    )
    return pcm[:keep]


def _find_silence_boundary(pcm, nominal_offset, sample_rate, search_seconds=1.0):
    """Refine a cut point onto the pause between readings.

    The transcript establishes how many readings there are, which puts the boundary at
    len/N. That is a byte offset, not a speech boundary, so cutting there can clip the
    tail of the first reading or leave a syllable of the second. Speakers pause between
    readings, so this searches nearby for the quietest short window and cuts in its
    middle.

    This refines a boundary already established from the transcript. It does not
    estimate how long the clip should be.

    Args:
        pcm: Raw 16-bit mono PCM.
        nominal_offset: Byte offset of the boundary implied by the reading count.
        sample_rate: Samples per second.
        search_seconds: How far either side of the nominal offset to search.

    Returns:
        A byte offset aligned to a 2-byte sample boundary.
    """
    import array

    bytes_per_sample = 2
    window = int(sample_rate * 0.05) * bytes_per_sample          # 50 ms window
    span = int(sample_rate * search_seconds) * bytes_per_sample

    low = max(0, nominal_offset - span)
    high = min(len(pcm), nominal_offset + span)
    if high - low < window * 2:
        return nominal_offset - (nominal_offset % bytes_per_sample)

    step = max(window // 4, bytes_per_sample)
    measurements = []

    for start in range(low, high - window, step):
        aligned = start - (start % bytes_per_sample)
        samples = array.array("h")
        samples.frombytes(pcm[aligned:aligned + window])
        if not samples:
            continue
        # Mean absolute amplitude is enough to locate a pause and is far cheaper than
        # RMS across a long clip.
        energy = sum(abs(s) for s in samples) / len(samples)
        measurements.append((energy, aligned + window // 2))

    if not measurements:
        return nominal_offset - (nominal_offset % bytes_per_sample)

    quietest_energy = min(energy for energy, _ in measurements)
    # A pause spans many windows that are all equally quiet. Taking the first match
    # would cut at the moment speech stops, clipping the following reading's lead-in
    # and leaving the tail of this one abrupt. The median of the tied-quietest windows
    # lands in the middle of the pause instead.
    tolerance = quietest_energy * 0.15 + 5
    quiet_centres = sorted(
        centre for energy, centre in measurements if energy <= quietest_energy + tolerance
    )
    quietest_offset = quiet_centres[len(quiet_centres) // 2]

    offset = quietest_offset - (quietest_offset % bytes_per_sample)
    logger.info(
        f"Nova Sonic: refined cut from {nominal_offset/(sample_rate*2):.2f}s to "
        f"{offset/(sample_rate*2):.2f}s on the pause between readings "
        f"(quietest window amplitude {quietest_energy:.0f})"
    )
    return offset


def _chunk_text_for_tts(text, max_words=200):
    """Split text into chunks that stay within Nova Sonic's per-session output limit.

    Nova Sonic caps a single synthesis at roughly ~2 minutes of speech. At ~2.5
    words/sec that's ~300 words, so we target ~200 words (~80s) per chunk and
    split on sentence boundaries so chunks sound natural when stitched.
    """
    text = (text or "").strip()
    if not text:
        return []

    # Split into sentences (keep the terminal punctuation)
    sentences = re.split(r"(?<=[.!?])\s+", text)
    chunks = []
    current = []
    current_words = 0
    for sentence in sentences:
        words = len(sentence.split())
        # A single very long sentence: hard-split it by words
        if words > max_words:
            if current:
                chunks.append(" ".join(current))
                current, current_words = [], 0
            tokens = sentence.split()
            for i in range(0, len(tokens), max_words):
                chunks.append(" ".join(tokens[i:i + max_words]))
            continue
        if current_words + words > max_words and current:
            chunks.append(" ".join(current))
            current, current_words = [], 0
        current.append(sentence)
        current_words += words
    if current:
        chunks.append(" ".join(current))
    return chunks


async def nova_sonic_synthesize_long(text, voice_id, region="us-east-1", language="en"):
    """Synthesize narration of any length.

    A single Nova Sonic session can stream up to ~8 minutes of audio in one
    continuous read (long text is sent as multiple textInput events inside one
    content block — see nova_sonic_synthesize), so chunking is avoided for
    normal-length narration: every chunk seam risks dropped or paraphrased words.

    Only extremely long scripts, beyond what fits in ~8 minutes, are split, and
    then on large sentence-aligned boundaries with a single retry per part.

    Args:
        text: Narration to synthesize.
        voice_id: Nova Sonic voice id, already validated for the language.
        region: Bedrock region hosting Nova Sonic.
        language: Project language code.

    Returns:
        Concatenated PCM bytes, or None/empty when synthesis produced no audio.
    """
    word_count = len(text.split())

    if word_count <= NOVA_SONIC_SESSION_WORD_LIMIT:
        return await nova_sonic_synthesize(text, voice_id, region, language)

    chunks = _chunk_text_for_tts(text, max_words=NOVA_SONIC_SESSION_WORD_LIMIT)
    if len(chunks) <= 1:
        return await nova_sonic_synthesize(text, voice_id, region, language)

    logger.info(
        f"Nova Sonic: narration is {word_count} words, splitting into {len(chunks)} "
        f"sessions of up to {NOVA_SONIC_SESSION_WORD_LIMIT} words"
    )
    SAMPLE_RATE = 24000
    pad = b"\x00\x00" * int(SAMPLE_RATE * 0.2)  # ~200ms gap between parts
    all_pcm = []
    failed_parts = []

    for i, chunk in enumerate(chunks):
        pcm = None
        for attempt in range(2):
            try:
                pcm = await nova_sonic_synthesize(chunk, voice_id, region, language)
                if pcm:
                    break
            except Exception as e:
                logger.warning(f"Nova Sonic part {i+1}/{len(chunks)} attempt {attempt+1} failed: {e}")
        if pcm:
            if all_pcm:
                all_pcm.append(pad)
            all_pcm.append(pcm)
            # Flag a part whose audio is far shorter than its word count implies. This is
            # the signal that a session hit an output cap, which previously happened
            # silently and left narration ending mid-sentence.
            spoken_seconds = len(pcm) / (SAMPLE_RATE * 2)
            chunk_words = len(chunk.split())
            if spoken_seconds > 0 and chunk_words / spoken_seconds > 6.0:
                logger.error(
                    f"Nova Sonic part {i+1}/{len(chunks)} looks truncated: {chunk_words} words "
                    f"in only {spoken_seconds:.1f}s of audio. The session likely hit its output cap."
                )
            else:
                logger.info(
                    f"Nova Sonic part {i+1}/{len(chunks)} ok ({chunk_words} words, {spoken_seconds:.1f}s)"
                )
        else:
            failed_parts.append(i + 1)
            logger.error(f"Nova Sonic part {i+1}/{len(chunks)} produced no audio after retry")

    if failed_parts:
        # Returning partial audio silently is what made the original truncation hard to
        # spot. The caller still gets what succeeded, but the gap is recorded loudly.
        logger.error(
            f"Nova Sonic: {len(failed_parts)} of {len(chunks)} parts produced no audio "
            f"(parts {failed_parts}); the narration is incomplete"
        )

    return b"".join(all_pcm)


def _polly_fallback(text, shot_index, voice_id, key, language="en"):
    """Fall back to Polly when Nova Sonic produces no audio.

    Polly has no fr-FR generative voice, so French narration is voiced with the
    fr-CA generative voices (Gabrielle, Liam) mapped in VOICE_CATALOG. Using an
    English voice here would read French text with English phonetics.

    Args:
        text: Narration to synthesize.
        shot_index: Shot index, echoed back to the caller.
        voice_id: Nova Sonic voice id that was originally requested.
        key: Intended S3 key; the extension is switched to .mp3.
        language: Project language code.

    Returns:
        An API Gateway response dict.
    """
    polly_voice = resolve_voice(voice_id.lower(), language)["polly"]
    try:
        resp = polly.synthesize_speech(
            Text=text, OutputFormat="mp3", VoiceId=polly_voice, Engine="generative",
        )
        audio_bytes = resp["AudioStream"].read()
        mp3_key = key.replace(".wav", ".mp3")
        s3_put(mp3_key, audio_bytes, "audio/mpeg")
        logger.info(f"Polly fallback produced audio with voice {polly_voice} ({language})")
        return respond(200, {"audio_url": presigned_url(mp3_key), "audio_key": mp3_key, "shot_index": shot_index})
    except ClientError as e:
        logger.exception(f"Polly fallback failed for voice {polly_voice} ({language})")
        return respond(500, {"detail": f"Audio generation failed: {e}"})


# ═══════════════════════════════════════════════════════════════
# ROUTE HANDLERS — matching original server.py contracts
# ═══════════════════════════════════════════════════════════════

def handle_health(event):
    return respond(200, {"status": "ok", "service": SERVICE_NAME, "timestamp": now_iso()})


# ── Extract Text (from uploaded .docx/.txt file via multipart) ──
def handle_extract_text(event):
    if is_multipart(event):
        file_data, filename, ct = parse_multipart(event)
    else:
        # Fallback: try JSON body with base64 file
        body = parse_json_body(event)
        file_b64 = body.get("file", "")
        filename = body.get("filename", "upload.txt")
        if file_b64:
            file_data = base64.b64decode(file_b64)
        else:
            return respond(400, {"detail": "No file uploaded"})
        ct = "application/octet-stream"

    if not file_data:
        return respond(400, {"detail": "No file data received"})

    ext = filename.rsplit(".", 1)[-1].lower() if "." in filename else ""
    logger.info(f"extract-text: filename={filename}, ext={ext}, size={len(file_data)}")

    if ext in ("txt", "md"):
        text = file_data.decode("utf-8", errors="replace")
        return respond(200, {"text": text})

    if ext in ("docx", "doc"):
        try:
            import zipfile
            # DOCX is a zip file containing XML
            with zipfile.ZipFile(io.BytesIO(file_data)) as zf:
                # Read the main document content
                if "word/document.xml" in zf.namelist():
                    xml_content = zf.read("word/document.xml").decode("utf-8")
                    # Strip XML tags to get plain text
                    # Extract text between <w:t> tags
                    texts = re.findall(r"<w:t[^>]*>([^<]+)</w:t>", xml_content)
                    # Also handle paragraph breaks
                    paragraphs = []
                    current_para = []
                    for match in re.finditer(r"(<w:p[ >]|<w:p/>|<w:t[^>]*>([^<]*)</w:t>)", xml_content):
                        if match.group(1).startswith("<w:p"):
                            if current_para:
                                paragraphs.append("".join(current_para))
                                current_para = []
                        elif match.group(2) is not None:
                            current_para.append(match.group(2))
                    if current_para:
                        paragraphs.append("".join(current_para))

                    text = "\n\n".join(p for p in paragraphs if p.strip())
                    if text.strip():
                        return respond(200, {"text": text})

                # Fallback: just extract all text-like content
                text = " ".join(texts) if texts else ""
                if text.strip():
                    return respond(200, {"text": text})

            return respond(200, {"text": "(Could not extract text from document)"})
        except Exception as e:
            logger.exception("DOCX extraction failed")
            return respond(500, {"detail": f"DOCX extraction failed: {e}"})

    return respond(400, {"detail": f"Unsupported file type: .{ext}"})


# ── Process Script — Async pattern ──
# POST /api/process-script returns immediately with a job_id
# The heavy work runs asynchronously via self-invocation
# Frontend polls GET /api/script-status/{job_id}

def handle_process_script(event):
    """Kick off async script processing. Returns job_id immediately.

    The request carries the project language, chosen by the user on the upload
    step. It is normalized once here and then threaded through the whole job so
    every downstream step agrees on it.
    """
    body = parse_json_body(event)
    script = body.get("script", "").strip()
    if not script:
        return respond(400, {"detail": "script is required"})

    language = normalize_language(body.get("language"))
    body["language"] = language

    job_id = datetime.now(timezone.utc).strftime("%Y-%m-%d_%H%M%S")

    # Store initial status
    s3_put(f"jobs/{job_id}/status.json", json.dumps({
        "job_id": job_id,
        "status": "processing",
        "detail": status_message("queued", language),
        "progress": 10,
        "language": language,
    }).encode(), "application/json")

    # Invoke self asynchronously with the processing payload
    payload = {
        "_async_task": "process_script",
        "job_id": job_id,
        **body,
    }
    lambda_client.invoke(
        FunctionName=SELF_FUNCTION_NAME,
        InvocationType="Event",
        Payload=json.dumps(payload).encode(),
    )

    logger.info(f"Queued script processing job {job_id} (language={language})")
    return respond(200, {"job_id": job_id, "status": "processing", "language": language})


def handle_script_status(event):
    """Poll for script processing results."""
    job_id = path_param(event, "job_id")
    if not job_id:
        return respond(400, {"detail": "job_id is required"})

    status_key = f"jobs/{job_id}/status.json"
    if not s3_exists(status_key):
        return respond(404, {"detail": "Job not found"})

    data, _ = s3_get(status_key)
    return respond(200, json.loads(data))


def handle_regenerate_character_sheet(event):
    """Regenerate the character sheet image from updated descriptions.

    Saves to the reference path that shot generation reads from, so a regenerated
    sheet is picked up by subsequent image generation.
    """
    body = parse_json_body(event)
    run_id = body.get("run_id", "")
    characters = body.get("characters", {})
    style_hint = body.get("style_hint", "clean illustration")

    if not run_id or not characters:
        return respond(400, {"detail": "run_id and characters are required"})

    # The user edits descriptions in the project language, but the sheet is drawn
    # by an image model, so translate before prompting.
    language = normalize_language(body.get("language") or get_run_language(run_id))
    characters_en = translate_characters_to_english(characters, language)
    style_hint = translate_prompt_to_english(style_hint, language)

    char_desc = "\n".join([f"- {name}: {desc}" for name, desc in characters_en.items()])

    # Add a unique variation seed to prevent Gemini from returning similar results
    import random
    variation_seed = random.randint(1000, 9999)
    pose_variations = [
        "standing in a neutral pose, full body, facing forward",
        "standing in a relaxed pose, full body, slightly angled",
        "standing upright, full body, facing the viewer directly",
        "in a natural standing position, full body, facing forward with arms at sides",
    ]
    pose = pose_variations[variation_seed % len(pose_variations)]

    sheet_prompt = (
        f"Create a CHARACTER REFERENCE SHEET on a clean white background. "
        f"Show each character {pose}, clearly separated with space between them. "
        f"Label each character with their name below them in clear text. "
        f"Style: {style_hint}. "
        f"IMPORTANT — use these EXACT descriptions for each character:\n{char_desc}\n\n"
        f"Variation #{variation_seed}. Make each character visually distinct and match their description precisely."
    )

    logger.info(f"Regenerating character sheet for run {run_id} with {len(characters)} characters (variation {variation_seed})")
    image_bytes = _call_gemini_image(sheet_prompt, timeout=120)

    if not image_bytes:
        return respond(500, {"detail": "Failed to generate character sheet"})

    # Save to the CORRECT reference path so shot generation picks it up
    char_sheet_key = f"runs/{run_id}/references/character-sheet.png"
    s3_put(char_sheet_key, image_bytes, "image/png")
    logger.info(f"Character sheet regenerated and saved: {char_sheet_key} ({len(image_bytes)} bytes)")

    return respond(200, {"image_url": presigned_url(char_sheet_key)})


def handle_approve_characters(event):
    """User approves (or modifies) characters, then resume shot generation."""
    job_id = path_param(event, "job_id")
    if not job_id:
        return respond(400, {"detail": "job_id is required"})

    body = parse_json_body(event)
    logger.info(f"approve-characters body keys: {list(body.keys()) if isinstance(body, dict) else type(body)}")
    approved_characters = body.get("characters") or body

    # If the body itself is the characters dict (no wrapper), use it directly
    if not isinstance(approved_characters, dict) or not approved_characters:
        logger.warning(f"approve-characters: invalid characters. Body={str(body)[:300]}")
        return respond(400, {"detail": "characters is required"})

    # Load the saved resume payload
    resume_key = f"jobs/{job_id}/resume_payload.json"
    if not s3_exists(resume_key):
        return respond(404, {"detail": "No pending character review for this job"})

    resume_data, _ = s3_get(resume_key)
    resume_payload = json.loads(resume_data)

    # Update with approved characters
    resume_payload["characters"] = approved_characters
    resume_payload["_characters_approved"] = True

    # The language was fixed when the job was created; the resume payload carries it.
    language = normalize_language(resume_payload.get("language"))
    detail = status_message("characters_approved", language)

    # Update status to show we're resuming
    s3_put(f"jobs/{job_id}/status.json", json.dumps({
        "job_id": job_id,
        "status": "processing",
        "detail": detail,
        "progress": 60,
        "language": language,
    }).encode(), "application/json")

    # Re-invoke self asynchronously to continue processing
    lambda_client.invoke(
        FunctionName=SELF_FUNCTION_NAME,
        InvocationType="Event",
        Payload=json.dumps({
            "_async_task": "process_script",
            **resume_payload,
        }).encode(),
    )

    return respond(200, {"status": "processing", "detail": detail, "language": language})


def _async_process_script(payload):
    """Heavy processing — runs asynchronously. Extracts characters, generates shots.

    Language handling: `characters` holds descriptions in the project language and
    is what the user sees and edits. `characters_en` holds the English equivalents
    and is what gets pasted into image prompts. For English projects the two are
    identical.
    """
    job_id = payload["job_id"]
    script = payload.get("script", "").strip()
    shot_count = payload.get("shot_count", 8)
    style_override = payload.get("style_override", "")
    narrative_style = payload.get("narrative_style", "")
    image_model = payload.get("image_model", "sd35")
    reference_images_input = payload.get("reference_images", [])  # [{label, data (base64)}]
    language = normalize_language(payload.get("language"))
    language_block = language_directive(language)

    def update_status(detail, progress, **extra):
        s3_put(f"jobs/{job_id}/status.json", json.dumps({
            "job_id": job_id, "status": "processing",
            "detail": detail, "progress": progress, "language": language, **extra,
        }).encode(), "application/json")

    try:
        # ─── Check if this is a resumed job (characters already approved) ───
        if payload.get("_characters_approved"):
            characters = payload.get("characters", {})
            art_direction = payload.get("art_direction", style_override)
            update_status(status_message("characters_approved_regen", language), 55)

            # The user may have edited descriptions in French; the sheet is drawn by
            # an image model, so translate before prompting.
            characters_en = translate_characters_to_english(characters, language)
            art_direction_en = translate_prompt_to_english(art_direction, language)

            # Regenerate character sheet with the approved (possibly edited) descriptions
            char_descriptions = "\n".join([f"- {name}: {desc}" for name, desc in characters_en.items()])
            char_sheet_prompt = (
                f"Create a CHARACTER REFERENCE SHEET on a clean white background. "
                f"Show each character standing in a neutral pose, full body, facing forward, clearly separated. "
                f"Label each with their name. Style: {art_direction_en or 'clean illustration'}. "
                f"Characters:\n{char_descriptions}"
            )
            char_sheet_bytes = _call_gemini_image(char_sheet_prompt, timeout=120)
            if char_sheet_bytes:
                char_sheet_key = f"runs/{job_id}/references/character-sheet.png"
                s3_put(char_sheet_key, char_sheet_bytes, "image/png")
                logger.info(f"Character sheet regenerated on approval: {char_sheet_key} ({len(char_sheet_bytes)} bytes)")
            else:
                logger.warning(f"Failed to regenerate character sheet on approval for {job_id}")

            update_status(status_message("characters_approved", language), 60)
        else:
            # ─── PASS 1: Extract characters with exhaustive visual detail ───
            update_status(status_message("analyzing_script", language), 15)

        character_prompt = f"""Analyze this script and identify EVERY SINGLE PERSON or PERSONIFIED ENTITY who appears or is mentioned, including:
- Main characters (named individuals)
- Children, family members, companions (even if not named — give them a name like "Sofia's Son" or "Sofia's Daughter")
- Supporting characters (agents, experts, staff)
- AI assistants, bots, virtual assistants, voice assistants, or any technology that is personified or "speaks/helps" in the script — treat these as CHARACTERS too
- Background figures only if they recur

If the script references a number of children or family members (e.g. "mother of two"), create that many distinct child characters.

═══ AI / BOT / ASSISTANT CHARACTERS ═══
If the script includes an AI, bot, digital assistant, or similar personified technology:
- Make it a distinct, ADJUSTABLE character with its own visual design
- Design it as a FRIENDLY, approachable, stylized AI persona — NOT a realistic human
- Default to a clearly non-human but warm look: e.g. a soft glowing rounded orb/avatar, a cute friendly robot, a simple animated assistant figure, gentle expressive features, soft colors
- Do NOT give it realistic human skin/hair/body UNLESS the script explicitly describes it as a human
- Keep it inviting and helpful in appearance (soft edges, warm friendly expression), never cold or menacing

For EACH character, create a LOCKED visual design. Invent ALL details not mentioned in the script — what matters is that the design is SPECIFIC and REPEATABLE:

1. HAIR / TOP FEATURE: Exact color + style (for AI: describe its top form, e.g. "smooth rounded dome with a soft cyan glow")
2. EYES: Exact color + shape (for AI: friendly expressive eyes, e.g. "two warm glowing oval eyes")
3. SKIN / SURFACE: Exact tone or material (for AI: e.g. "matte white casing with soft teal accent lights")
4. AGE: Specific age or range (for AI: "ageless friendly assistant")
5. BUILD / FORM: Body type or form factor (for AI: e.g. "floating rounded orb" or "small friendly desktop robot")
6. CLOTHING / TRIM: Exact outfit with colors (for AI: accent colors/trim instead of clothing)
7. UNIQUE FEATURES: Something distinctive (e.g., "round face with dimples", or for AI "gentle pulsing light ring")

Write each as ONE DENSE LINE — this exact text will be pasted into every image prompt where they appear.

{"ALSO — define the OVERALL VISUAL STYLE based on this reference:" if style_override else ""}
{"Style reference: " + style_override if style_override else ""}

Return ONLY valid JSON. No markdown, no code blocks. Format:
{{"characters": {{"Character Name": "one-line visual description..."}}, "art_direction": "short style description for all shots"}}
{language_block}"""

        char_result = call_claude(character_prompt, script, max_tokens=3000)
        json_match = re.search(r"\{[\s\S]*\}", char_result)
        characters = {}
        art_direction = style_override
        if json_match:
            try:
                char_data = json.loads(json_match.group())
                characters = char_data.get("characters", {})
                # The USER'S chosen style is authoritative. Only fall back to
                # Claude's generated art_direction when no explicit style was provided.
                # Otherwise Claude's "cinematic photography" description fights the
                # user's chosen look (e.g. anime) and the style drifts to realism.
                if char_data.get("art_direction") and not style_override:
                    art_direction = char_data["art_direction"]
            except json.JSONDecodeError:
                pass

        update_status(
            status_message("characters_found", language, count=len(characters), shots=shot_count), 40
        )

        # English mirror of the character bible. Descriptions are pasted verbatim
        # into image prompts, so they have to be English even when the project — and
        # everything the user sees — is French.
        characters_en = translate_characters_to_english(characters, language)

        # Build character reference block — very explicit
        char_block = ""
        if characters_en:
            char_lines = []
            for name, desc in characters_en.items():
                char_lines.append(f"  [{name.upper()}]: {desc}")
            char_block = """═══ CHARACTER BIBLE ═══
These are LOCKED character designs. When a character appears in a shot, you MUST include their COMPLETE description in the image prompt. Do NOT summarize, abbreviate, or paraphrase — copy the full description.
These descriptions are already in English and belong in the English image_prompt exactly as written.

""" + "\n\n".join(char_lines)
        # These are logos, scenery, products, etc. that should appear in shots.
        # We store them individually AND create a labeled composite sheet.
        ref_image_labels = []  # list of labels for prompting
        if reference_images_input:
            update_status(
                status_message("storing_references", language, count=len(reference_images_input)), 42
            )
            for i, ref in enumerate(reference_images_input):
                label = ref.get("label", f"Reference {i+1}").strip()
                data_b64 = ref.get("data", "")
                if not data_b64:
                    continue
                try:
                    img_bytes = base64.b64decode(data_b64)
                    safe_label = re.sub(r"[^a-z0-9]+", "-", label.lower()).strip("-")
                    ref_key = f"runs/{job_id}/references/user-ref-{i:02d}-{safe_label}.png"
                    s3_put(ref_key, img_bytes, "image/png")
                    ref_image_labels.append({"label": label, "key": ref_key, "index": i})
                    logger.info(f"Stored user reference image: '{label}' -> {ref_key} ({len(img_bytes)} bytes)")
                except Exception as e:
                    logger.warning(f"Failed to store reference image {i} '{label}': {e}")

        # If the user supplied a custom style image, store it DIRECTLY as the style
        # reference. Using the real image (instead of a synthetic one generated from a
        # text description) makes the style actually carry through to characters/shots.
        custom_style_image_b64 = payload.get("custom_style_image", "")
        has_custom_style_image = False
        if custom_style_image_b64:
            try:
                style_img_bytes = base64.b64decode(custom_style_image_b64)
                s3_put(f"runs/{job_id}/references/style-reference.png", style_img_bytes, "image/png")
                has_custom_style_image = True
                logger.info(f"Stored user custom style image as style reference ({len(style_img_bytes)} bytes)")
            except Exception as e:
                logger.warning(f"Failed to store custom style image: {e}")

        # ─── PASS 1.6: Generate character/style reference images ───

        # Define style_block early — needed for reference image generation.
        # style_block is the user-facing art direction and may be French; every
        # image model gets style_block_en instead.
        style_block = art_direction if art_direction else style_override
        style_block_en = translate_prompt_to_english(style_block, language)

        if characters:
            char_count = len(characters)

            if image_model in ("gemini", "nova"):
                # ── GEMINI / NOVA PATH: Use Gemini for reference generation ──
                # Both models use the character sheet as a visual reference (not IP-Adapter),
                # so we only need ONE combined sheet + style reference (2 calls, not N+2).
                # Nova Canvas doesn't have its own image-gen-from-text for reference sheets,
                # so we use Gemini to create the references for both paths.
                generated_portraits = {}  # name -> S3 key

                # Generate character sheet + style reference IN PARALLEL (saves ~30-60s)
                update_status(status_message("generating_refs", language, count=char_count), 45)
                # English descriptions: this prompt goes to an image model.
                char_descriptions = "\n".join([f"- {name}: {desc}" for name, desc in characters_en.items()])
                char_sheet_prompt = f"""Create a CHARACTER REFERENCE SHEET on a clean white background. 
Show each character standing in a neutral pose, full body, facing forward, clearly separated with space between them.
Label each character with their name below them in clear text.
Style: {style_block_en if style_block_en else 'clean illustration style'}

Characters to include:
{char_descriptions}

This is a reference sheet for an animation/illustration project. Each character should be clearly distinct and recognizable. White background, no scene elements, just the characters standing side by side."""

                style_ref_prompt = f"""Create a STYLE REFERENCE image showing a sample scene in this exact visual style:
{style_block_en if style_block_en else 'Modern flat illustration with clean lines and warm colors'}

Show a simple scene (a cozy room with a window, warm lighting) that demonstrates:
- The color palette
- The line work style
- The lighting approach
- The level of detail and texture
- The overall mood and atmosphere

This is a style reference — make it clearly demonstrate the artistic style without any specific characters or story elements. 16:9 aspect ratio."""

                # Run both Gemini calls in parallel using ThreadPoolExecutor
                from concurrent.futures import ThreadPoolExecutor, as_completed

                # If the user gave a custom style image, use it as a reference when
                # generating the character sheet so characters adopt that style.
                char_sheet_refs = None
                if has_custom_style_image:
                    char_sheet_refs = [{"data": custom_style_image_b64, "mimeType": "image/png"}]
                    char_sheet_prompt = (
                        "Using the attached image as a STYLE REFERENCE (match its art style, colors, "
                        "line work, and rendering exactly), " + char_sheet_prompt
                    )

                with ThreadPoolExecutor(max_workers=3) as executor:
                    future_sheet = executor.submit(_call_gemini_image, char_sheet_prompt, char_sheet_refs, 120)
                    # Only generate a synthetic style reference if the user didn't provide one
                    future_style = None
                    if not has_custom_style_image:
                        future_style = executor.submit(_call_gemini_image, style_ref_prompt, None, 90)

                    char_sheet_bytes = future_sheet.result()
                    style_ref_bytes = future_style.result() if future_style else None

                if char_sheet_bytes:
                    char_sheet_key = f"runs/{job_id}/references/character-sheet.png"
                    s3_put(char_sheet_key, char_sheet_bytes, "image/png")
                    logger.info(f"Combined character sheet generated: {char_sheet_key} ({len(char_sheet_bytes)} bytes)")

                if style_ref_bytes:
                    style_ref_key = f"runs/{job_id}/references/style-reference.png"
                    s3_put(style_ref_key, style_ref_bytes, "image/png")
                    logger.info(f"Style reference generated (Gemini): {style_ref_key}")

            else:
                # ── SDXL PATH: Use SageMaker SDXL for all reference generation ──
                # This ensures portraits are in the SAME model's visual language as the final shots.
                # Gemini portraits fed to SDXL IP-Adapter cause style mismatch.
                update_status(status_message("generating_portraits", language, count=char_count), 45)

                sagemaker_endpoint = os.environ.get("SAGEMAKER_ENDPOINT", "rit-sdxl-ip-adapter")
                sm_runtime = boto3.client("sagemaker-runtime", region_name="us-east-1")

                generated_portraits = {}  # name -> S3 key

                # First generate a style reference using Bedrock SD3.5 (no IP-Adapter needed)
                update_status(status_message("generating_style_ref", language), 44)
                style_ref_prompt = f"{style_block_en if style_block_en else 'Modern digital illustration, clean lines, warm colors'}, a cozy room interior with a window, warm golden lighting, soft shadows, no people, no text, no characters"
                try:
                    sd_body = json.dumps({
                        "prompt": style_ref_prompt,
                        "negative_prompt": "blurry, low quality, text, watermark, people, characters, faces",
                        "output_format": "jpeg",
                        "aspect_ratio": "16:9",
                    })
                    resp = bedrock_west.invoke_model(
                        modelId="stability.sd3-5-large-v1:0",
                        contentType="application/json",
                        accept="application/json",
                        body=sd_body,
                    )
                    result = json.loads(resp["body"].read())
                    images = result.get("images", [])
                    if images:
                        style_ref_bytes = base64.b64decode(images[0])
                        style_ref_key = f"runs/{job_id}/references/style-reference.png"
                        s3_put(style_ref_key, style_ref_bytes, "image/png")
                        logger.info(f"Style reference generated (SD3.5 Bedrock): {style_ref_key}")
                except Exception as e:
                    logger.warning(f"Style reference generation failed: {e}")

                # Generate individual character portraits using SageMaker SDXL
                # These will be used as IP-Adapter references for the actual shots.
                # Run up to 3 in parallel for speed.
                from concurrent.futures import ThreadPoolExecutor, as_completed

                def _generate_one_portrait(i, char_name, char_desc):
                    """Generate a single portrait via SageMaker or SD3.5 fallback."""
                    safe_name = re.sub(r"[^a-z0-9]+", "-", char_name.lower()).strip("-")
                    portrait_prompt = f"{style_block_en if style_block_en else 'Clean digital illustration'}, single character portrait, {char_desc}, standing upright facing forward, neutral pose, arms at sides, full body head to feet, centered in frame, plain white background, studio lighting, sharp details, character reference sheet style"

                    try:
                        sm_payload = {
                            "prompt": portrait_prompt,
                            "negative_prompt": "blurry, low quality, multiple people, crowd, background scene, environment, text, watermark, cropped, partial body, extra limbs, deformed",
                            "num_inference_steps": 30,
                            "guidance_scale": 7.5,
                            "width": 768,
                            "height": 1024,
                            "seed": i + 42,
                        }
                        if s3_exists(f"runs/{job_id}/references/style-reference.png"):
                            style_data, _ = s3_get(f"runs/{job_id}/references/style-reference.png")
                            sm_payload["style_reference_image"] = base64.b64encode(style_data).decode()
                            sm_payload["ip_adapter_scale"] = 0.3

                        response = sm_runtime.invoke_endpoint(
                            EndpointName=sagemaker_endpoint,
                            ContentType="application/json",
                            Body=json.dumps(sm_payload),
                        )
                        result = json.loads(response["Body"].read())
                        if isinstance(result, list):
                            result = json.loads(result[0]) if result else {}
                        if "image" in result:
                            portrait_bytes = base64.b64decode(result["image"])
                            portrait_key = f"runs/{job_id}/references/char-{safe_name}.png"
                            s3_put(portrait_key, portrait_bytes, "image/png")
                            logger.info(f"Character portrait generated (SDXL): {char_name} -> {portrait_key}")
                            return (char_name, portrait_key)
                    except Exception as e:
                        logger.warning(f"SDXL portrait failed for {char_name}: {e}")

                    # Fallback to SD3.5
                    try:
                        sd_body = json.dumps({
                            "prompt": portrait_prompt,
                            "negative_prompt": "blurry, low quality, multiple people, crowd, text, watermark, cropped",
                            "output_format": "jpeg",
                            "aspect_ratio": "3:4",
                        })
                        resp = bedrock_west.invoke_model(
                            modelId="stability.sd3-5-large-v1:0",
                            contentType="application/json",
                            accept="application/json",
                            body=sd_body,
                        )
                        result = json.loads(resp["body"].read())
                        images = result.get("images", [])
                        if images:
                            portrait_bytes = base64.b64decode(images[0])
                            portrait_key = f"runs/{job_id}/references/char-{safe_name}.png"
                            s3_put(portrait_key, portrait_bytes, "image/png")
                            logger.info(f"Character portrait generated (SD3.5 fallback): {char_name}")
                            return (char_name, portrait_key)
                    except Exception as e:
                        logger.warning(f"SD3.5 fallback also failed for {char_name}: {e}")
                    return None

                update_status(status_message("generating_portraits", language, count=char_count), 48)
                with ThreadPoolExecutor(max_workers=3) as executor:
                    # English descriptions: these prompts go to an image model.
                    futures = {executor.submit(_generate_one_portrait, i, name, desc): name
                               for i, (name, desc) in enumerate(characters_en.items())}
                    for future in as_completed(futures):
                        result = future.result()
                        if result:
                            generated_portraits[result[0]] = result[1]

        update_status(status_message("generating_shots", language, count=shot_count), 60)

        # If characters haven't been approved yet, pause for review
        if not payload.get("_characters_approved"):
            # Generate presigned URL for character sheet if it exists
            char_sheet_url = None
            char_sheet_key = f"runs/{job_id}/references/character-sheet.png"
            if s3_exists(char_sheet_key):
                char_sheet_url = presigned_url(char_sheet_key)

            # Store characters and pause for user review
            s3_put(f"jobs/{job_id}/status.json", json.dumps({
                "job_id": job_id,
                "status": "characters_ready",
                "detail": status_message("characters_ready", language, count=len(characters)),
                "progress": 55,
                "characters": characters,
                "characters_en": characters_en,
                "art_direction": art_direction,
                "image_model": image_model,
                "language": language,
                "character_sheet_url": char_sheet_url,
            }).encode(), "application/json")
            # Store the full payload for resumption
            resume_payload = {k: v for k, v in payload.items() if k != "reference_images"}
            resume_payload["characters"] = characters
            resume_payload["characters_en"] = characters_en
            resume_payload["art_direction"] = art_direction
            resume_payload["language"] = language
            s3_put(f"jobs/{job_id}/resume_payload.json", json.dumps(resume_payload).encode(), "application/json")
            return  # Stop here — user will approve characters and trigger phase 2

        # ─── PASS 2: Generate shots ───

        if image_model == "sd35":
            model_guidance = """IMAGE MODEL: SDXL + IP-Adapter (character identity handled by reference images).

CRITICAL: Individual character reference portraits are passed to the model via IP-Adapter.
The IP-Adapter handles facial identity, body type, and appearance automatically.
Your prompt must COMPLEMENT the reference — focus on POSE, SCENE, ACTION, and LIGHTING.

FOLLOW THIS EXACT PROMPT STRUCTURE:
[STYLE_PREFIX], [character action & pose], [scene/environment], [composition & framing], [lighting & mood]

ABSOLUTE RULES:
1. EVERY prompt MUST start with the EXACT SAME style prefix (provided below). No variations, no additions.
2. DO NOT describe facial features, hair color, eye color, skin tone, or body type — IP-Adapter handles this.
3. DO NOT invent new style terms — use ONLY the style prefix provided.
4. DO NOT use abstract/conceptual imagery (glowing networks, holograms, digital interfaces, floating UI).
   Every shot must show REAL PEOPLE in REAL ENVIRONMENTS doing REAL ACTIONS.
5. DO describe: pose, expression (smiling, focused, excited), action, clothing ONLY if plot-relevant.
6. DO describe: environment, props, background, atmosphere.
7. DO specify: camera angle (close-up, medium shot, wide shot), lighting direction.
8. Keep prompts 100-180 characters AFTER the style prefix. SHORTER = BETTER for IP-Adapter consistency.
9. Use the SAME lighting direction across all shots (e.g., "warm golden hour side lighting" in every shot).
10. Use CONSISTENT environments — if the story is about a family trip, show them in domestic/travel settings, NOT abstract tech scenes.

GOOD EXAMPLES:
"[STYLE_PREFIX], a woman sitting at a desk typing on a laptop, cozy living room, warm golden hour side lighting, medium shot"
"[STYLE_PREFIX], a woman and two children walking hand-in-hand through an autumn park, warm golden light, wide shot"
"[STYLE_PREFIX], close-up of a woman smiling at her phone screen, soft diffused window light, shallow depth of field"

BAD EXAMPLES (will break consistency):
"Semi-realistic digital illustration, a woman with brown hair..." (WRONG: invented new style)
"[STYLE_PREFIX], sweeping aerial view of Toronto skyline with glowing digital network lines" (WRONG: abstract/conceptual, no people)
"[STYLE_PREFIX], a woman speaking to a floating holographic AI assistant" (WRONG: sci-fi/abstract element)
"[STYLE_PREFIX], a laptop screen showing a German-language portal" (WRONG: UI screenshot, not a scene with people)
"""
        else:
            if image_model == "nova":
                model_guidance = """IMAGE MODEL: Amazon Nova Canvas.

Nova Canvas works best with DESCRIPTIVE CAPTIONS, not commands. Write prompts as if describing an image that already exists.

PROMPT STRUCTURE (max 1024 characters):
[Subject] + [Action/Pose] + [Environment] + [Lighting] + [Camera/Framing] + [Style]

KEY RULES:
- Write as a descriptive image caption, NOT a command (e.g., "A woman sitting..." not "Generate a woman...")
- DO NOT use negation words ("no", "not", "without") — these cause the OPPOSITE effect
- Be SPECIFIC about colors, materials, textures, positions
- Place the MOST IMPORTANT details at the START of the prompt (least important at end)
- Include lighting details to set mood: "soft golden hour light", "dramatic side lighting"
- Specify camera framing: "close-up portrait", "wide-angle shot", "slightly elevated 45-degree angle"
- Specify visual style: "photorealistic", "watercolor illustration", "cinematic quality"
- For characters: describe them as the primary subject with full physical details from the CHARACTER BIBLE
- Keep prompts under 800 characters (leave room for style suffix)

GOOD NOVA CANVAS PROMPT EXAMPLES:
"A warm, photorealistic portrait of a young woman with chestnut-brown hair in a ponytail, wearing a teal sweater, sitting at a wooden desk typing on a laptop. Cozy European living room with large arched windows. Soft golden hour light streaming in, creating warm highlights. Medium shot, slightly elevated angle, shallow depth of field."
"Whimsical children's book illustration: A mother and two young children walking hand-in-hand through an autumn park with golden leaves. Warm afternoon sunlight filtering through trees. Wide shot, eye-level perspective, soft pastel color palette with clean lines."
"""
            else:
                model_guidance = """IMAGE MODEL: Advanced (Gemini).

CRITICAL: A style reference IMAGE is passed alongside every prompt. The image defines the visual style.
Your text prompt should focus on SCENE CONTENT, not style description.

FOLLOW THIS EXACT PROMPT FORMULA:
[SHORT_STYLE_TAG], [character with key visual traits], [action/pose], [environment], [lighting], [camera framing]

KEY RULES:
- The style reference image handles color palette, line work, and artistic style — do NOT repeat style details in text
- Describe the scene NARRATIVELY — write it like you're directing a scene
- Characters must be the PRIMARY SUBJECT — include their key visual traits (hair color, clothing, distinguishing features)
- Use POSITIVE framing — describe what you WANT (e.g., "empty street" not "no cars")
- Use cinematic terms: "medium shot", "close-up", "wide shot", "eye-level"
- Define lighting: "warm golden hour light", "soft diffused window light"
- Keep prompts FOCUSED on the scene — max 300 characters
- Every shot must show PEOPLE doing REAL ACTIONS in REAL SETTINGS
- Do NOT describe abstract concepts, UI screens, or floating elements

GOOD PROMPT EXAMPLE:
"Pastel cartoon style, Sofia with chestnut-brown ponytail and teal sweater sitting at a wooden desk with her two children beside her, typing on a laptop in a cozy living room, warm golden light from window, medium shot"
"""

        narrative_block = f"\nNARRATIVE STYLE: {narrative_style}" if narrative_style else ""

        # For SD3.5, condense the style to just key words
        if style_block and image_model == "sd35":
            # Ask Claude to condense the style to short keywords
            try:
                condensed_style = call_claude(
                    "Condense this visual style description into a SHORT style prefix in ENGLISH for Stable Diffusion 3.5 (max 15 words). Use art style terms like 'digital illustration', 'concept art', 'cinematic photography', etc. Return ONLY the style prefix, nothing else.",
                    style_block_en,
                    max_tokens=100,
                    fast=True,
                )
                style_keywords = condensed_style.strip().strip('"').strip("'")
            except Exception:
                style_keywords = style_block_en[:60]
        elif style_block and image_model in ("gemini", "nova"):
            # For Gemini/Nova: the style reference IMAGE handles visual consistency.
            # Use only a SHORT style tag in the text prompt (not the full description).
            # The full description was used to generate the style reference image.
            try:
                style_keywords = call_claude(
                    "Condense this visual style description into a SHORT style tag in ENGLISH (max 10 words) for use as a prompt prefix. Examples: 'pastel cartoon illustration style', 'bold corporate marketing illustration', 'cinematic photorealistic style'. Return ONLY the short tag, nothing else.",
                    style_block_en,
                    max_tokens=50,
                    fast=True,
                )
                style_keywords = style_keywords.strip().strip('"').strip("'")
            except Exception:
                style_keywords = style_block_en[:40]
        else:
            style_keywords = style_block_en

        # Build character name list for the "characters_in_shot" field
        char_names_list = list(characters.keys()) if characters else []
        char_names_json = json.dumps(char_names_list)

        # Model-specific instructions for the system prompt
        if image_model == "sd35":
            prompt_rules = f"""For each shot produce:
1. "title": Short title (under 50 chars)
2. "image_prompt": CRITICAL RULES FOR SD3.5 + IP-ADAPTER:
   - Start EVERY prompt with this EXACT style prefix: "{style_keywords}"
   - DO NOT describe character appearance (face, hair, skin, body) — IP-Adapter handles identity
   - DO describe: action, pose, expression, environment, lighting, camera angle
   - EVERY shot must show REAL PEOPLE in REAL SETTINGS — no abstract visuals, no holograms, no floating UI, no aerial cityscapes
   - Use the SAME lighting across all shots (e.g., "warm golden hour side lighting")
   - Keep prompts SHORT (100-180 chars after prefix). Shorter = more consistent.
   - Max 250 characters total.
3. "narration": Voiceover text (~2-3 sentences, under 200 chars)
4. "characters_in_shot": Array of character names from the list below. EVERY shot MUST have at least one character."""
        else:
            max_chars = "400" if image_model == "nova" else "300"
            nova_note = "\n   - Write as a DESCRIPTIVE CAPTION, not a command. DO NOT use negation words." if image_model == "nova" else ""
            prompt_rules = f"""For each shot produce:
1. "title": Short title (under 50 chars)
2. "image_prompt": Follow the model-specific structure below. CRITICAL:
   - Start with the SHORT style tag, then describe the SCENE
   - Characters must be the PRIMARY SUBJECT — include key visual traits (hair, clothing) from CHARACTER BIBLE
   - Focus on: WHO is doing WHAT, WHERE, with what LIGHTING and CAMERA angle
   - Do NOT repeat the full style description — the style reference image handles that
   - Every shot must show PEOPLE in REAL SETTINGS doing REAL ACTIONS{nova_note}
   - Max {max_chars} characters
3. "narration": Voiceover text (~2-3 sentences, under 200 chars)
4. "characters_in_shot": Array of character names from the list below."""

        # Build reference images block for prompting
        ref_images_block = ""
        if ref_image_labels:
            ref_lines = []
            for ref in ref_image_labels:
                ref_lines.append(f"  - \"{ref['label']}\" (user-provided reference image)")
            ref_images_block = """
═══ REFERENCE IMAGES (incorporate these visual elements where relevant) ═══
The user has provided the following reference images. When the script mentions or implies these elements, include them naturally in the scene description:
""" + "\n".join(ref_lines) + """

For SD3.5/SDXL: mention the reference element by its label in the prompt (e.g., "with the [Company Logo] visible on the laptop screen").
For Gemini: describe how the reference element should appear in the scene.
Do NOT force every reference into every shot — only include them where they naturally fit the narrative."""

        system_prompt = f"""You are creating a visually consistent storyboard. Break the script into exactly {shot_count} shots.

{char_block}

═══ STYLE PREFIX (use this EXACT text at the start of every image_prompt) ═══
{style_keywords}

═══ ON-SCREEN TEXT RULES (apply to EVERY shot) ═══
When a shot includes any visible text (signs, screens, labels, captions, UI):
- Render text in ONE consistent clean sans-serif font across ALL shots
- Plain text only — do NOT place a banner, box, ribbon, highlight, or colored background behind the text
- Text sits directly on the scene with no backing shape; keep it simple, legible, and minimal
- Keep wording SHORT; avoid paragraphs of text in the image
- Do NOT add decorative title cards, watermarks, captions, or subtitles unless the script calls for it

{prompt_rules}

{model_guidance}
{narrative_block}
{ref_images_block}

Return ONLY a valid JSON array. No markdown, no code blocks. Format:
[{{"title":"...","image_prompt":"...","narration":"...","characters_in_shot":["Name1","Name2"]}}]

Available character names: {char_names_json}
{language_block}"""

        result = call_claude(system_prompt, script, max_tokens=8000)

        # Extract JSON
        json_match = re.search(r"\[[\s\S]*\]", result)
        if json_match:
            shots = json.loads(json_match.group())
        else:
            shots = json.loads(result)

        # Ensure fields and enforce style prefix on every prompt
        for s in shots:
            s.setdefault("title", "Untitled")
            s.setdefault("image_prompt", "")
            s.setdefault("narration", "")
            s.setdefault("characters_in_shot", [])
            s["image_url"] = None
            s["audio_url"] = None

            # Repair empty/whitespace image prompts so a shot is never left blank.
            # Build a sensible fallback from the style, title, characters, and narration.
            if not (s.get("image_prompt") or "").strip():
                chars_txt = ", ".join(s.get("characters_in_shot") or []) or "the main character"
                title_txt = (s.get("title") or "scene").strip()
                narr = (s.get("narration") or "").strip()
                scene_hint = f"{title_txt}. {narr}".strip()[:200]
                prefix = (style_keywords + ", ") if style_keywords else ""
                s["image_prompt"] = f"{prefix}{chars_txt} in a scene depicting: {scene_hint}, cinematic framing, warm natural lighting"
                logger.warning(f"Shot '{title_txt}' had an empty image_prompt — generated a fallback prompt")

            # Enforce the chosen style prefix on EVERY prompt, for every image model.
            #
            # The system prompt asks for it, but that is an instruction, not a
            # guarantee: Claude drops or invents a style prefix often enough to matter
            # (observed prompts beginning "Realistic!" on a pastel-cartoon project).
            # This used to run only for sd35, which left Gemini — the default model —
            # with no style signal in the text whenever Claude omitted the tag. The
            # output then fell back to whatever the reference images implied, so the
            # picked style appeared to have no effect and every shot converged on a
            # flat cartoon look.
            if style_keywords and s["image_prompt"]:
                prompt = s["image_prompt"]
                if not prompt.lower().startswith(style_keywords[:20].lower()):
                    # Strip any style-like prefix Claude invented, so the real prefix is
                    # not left competing with a contradictory one. Only a short leading
                    # clause is removed, to avoid eating actual scene content.
                    prompt = re.sub(r'^[^,]{0,60},\s*', '', prompt, count=1)
                    s["image_prompt"] = f"{style_keywords}, {prompt}"
                    logger.info(
                        f"Shot '{s.get('title', '?')}': prepended the style prefix that "
                        f"was missing from the generated prompt"
                    )

            # For SD3.5: ensure characters_in_shot is not empty (IP-Adapter needs references)
            if image_model == "sd35" and not s.get("characters_in_shot") and char_names_list:
                # Default to first character if Claude forgot to assign
                s["characters_in_shot"] = [char_names_list[0]]

        # ─── Enforce English image prompts ───
        # The system prompt already asks for English image_prompt values, but that is
        # an instruction, not a guarantee: when every other field is French the model
        # sometimes carries French into the prompt too. This pass is the actual
        # guarantee. Shots are translated in parallel because each is a separate
        # round trip and a 12-shot storyboard would otherwise add real latency.
        if language != "en":
            french_prompt_shots = [
                (i, s) for i, s in enumerate(shots)
                if s.get("image_prompt") and looks_like_french(s["image_prompt"])
            ]
            if french_prompt_shots:
                update_status(status_message("translating_prompts", language), 92)
                logger.info(f"Translating {len(french_prompt_shots)} French image prompt(s) to English")

                from concurrent.futures import ThreadPoolExecutor

                with ThreadPoolExecutor(max_workers=4) as executor:
                    translations = list(executor.map(
                        lambda pair: (pair[0], translate_prompt_to_english(pair[1]["image_prompt"], language)),
                        french_prompt_shots,
                    ))
                for index, english_prompt in translations:
                    shots[index]["image_prompt"] = english_prompt

        # Store completed result
        s3_put(f"jobs/{job_id}/status.json", json.dumps({
            "job_id": job_id,
            "status": "complete",
            "detail": status_message("complete", language, shots=len(shots), characters=len(characters)),
            "progress": 100,
            "shots": shots[:shot_count],
            "characters": characters,
            "characters_en": characters_en,
            "art_direction": art_direction,
            "image_model": image_model,
            "language": language,
            "style_key": payload.get("style_key", ""),
            "style_prefix": style_keywords,
        }).encode(), "application/json")

        # Also create a manifest so this run appears in Previous Runs immediately
        # (before video assembly — assets are saved as they're generated)
        project_name = payload.get("project_name", "")
        project_description = payload.get("project_description", "")
        s3_put(f"runs/{job_id}/manifest.json", json.dumps({
            "id": job_id,
            "created_at": now_iso(),
            "status": "storyboard",
            "project_name": project_name,
            "project_description": project_description,
            "image_model": image_model,
            # The project language is persisted so reopening a run later restores
            # the right voices, prompt handling, and console language.
            "language": language,
            # Which preset the user picked, and the condensed tag actually applied to
            # every prompt. Without these there is no way to tell afterwards whether a
            # style selection took effect, which is exactly what made the missing
            # prefix enforcement hard to diagnose.
            "style_key": payload.get("style_key", ""),
            "style_prefix": style_keywords,
            "characters": characters,
            "characters_en": characters_en,
            "art_direction": art_direction,
            "selected_voice": payload.get("selected_voice") or VOICE_CATALOG[language][0]["id"],
            "shots": [
                {
                    "index": i,
                    "image_key": "",
                    "audio_key": "",
                    "title": s.get("title", f"Shot {i+1}"),
                    "image_prompt": s.get("image_prompt", ""),
                    "narration": s.get("narration", ""),
                    "characters_in_shot": s.get("characters_in_shot", []),
                }
                for i, s in enumerate(shots[:shot_count])
            ],
            "settings": {},
        }).encode(), "application/json")

    except Exception as e:
        logger.exception(f"Async script processing failed for job {job_id}")
        s3_put(f"jobs/{job_id}/status.json", json.dumps({
            "job_id": job_id,
            "status": "error",
            "detail": str(e),
            "progress": 0,
            "language": language,
        }).encode(), "application/json")


# ── Generate Image (SD3.5 via Bedrock or Gemini via API) ──
def handle_generate_image(event):
    body = parse_json_body(event)
    shot_index = body.get("shot_index", 0)
    prompt = body.get("prompt", "")
    image_model = body.get("image_model", "sd35")
    run_id = body.get("run_id", "default")
    characters_in_shot = body.get("characters_in_shot", [])
    if not prompt:
        return respond(400, {"detail": "prompt is required"})

    # A user editing a prompt on a French project will naturally type French.
    # Image models need English, so translate on the way in. The prompt shown in
    # the console is left as the user wrote it.
    language = normalize_language(body.get("language") or get_run_language(run_id))
    prompt = translate_prompt_to_english(prompt, language)

    filename = f"shot-{shot_index + 1:02d}-{uuid.uuid4().hex[:8]}"
    
    if image_model == "gemini":
        result = _generate_image_gemini(shot_index, prompt, filename, run_id)
    elif image_model == "nova":
        result = _generate_image_nova(shot_index, prompt, filename, run_id)
    else:
        result = _generate_image_sd35(shot_index, prompt, filename, run_id, characters_in_shot)

    # Update manifest with the generated image key (so Previous Runs shows it)
    if result.get("statusCode") == 200 and run_id != "default" and shot_index < 900:
        try:
            result_body = json.loads(result.get("body", "{}"))
            # Prefer the exact image_key returned by the generator (avoids extension guessing)
            actual_key = result_body.get("image_key", "")
            if not actual_key and result_body.get("image_url"):
                model_used = result_body.get("model_used", "") or image_model
                ext = "png" if "gemini" in model_used or "nova" in model_used else "jpg"
                actual_key = f"runs/{run_id}/images/{filename}.{ext}"
            if actual_key:
                _update_manifest_shot(run_id, shot_index, image_key=actual_key)
        except Exception:
            pass

    return result


def _update_manifest_shot(run_id, shot_index, image_key=None, audio_key=None):
    """Update a shot's image/audio key in the manifest."""
    manifest_key = f"runs/{run_id}/manifest.json"
    if not s3_exists(manifest_key):
        return
    try:
        data, _ = s3_get(manifest_key)
        manifest = json.loads(data)
        shots = manifest.get("shots", [])
        if shot_index < len(shots):
            if image_key:
                shots[shot_index]["image_key"] = image_key
            if audio_key:
                shots[shot_index]["audio_key"] = audio_key
            manifest["shots"] = shots
            s3_put(manifest_key, json.dumps(manifest).encode(), "application/json")
    except Exception as e:
        logger.warning(f"Failed to update manifest for run {run_id}: {e}")


def _generate_image_sd35(shot_index, prompt, filename, run_id="default", characters_in_shot=None):
    """Generate via SDXL + IP-Adapter (SageMaker) or SD3.5 Style Guide (Bedrock).
    
    When characters_in_shot is provided, loads individual character portraits
    and passes them to SageMaker for identity-consistent generation.
    """
    key = f"runs/{run_id}/images/{filename}.jpg"
    characters_in_shot = characters_in_shot or []

    # Look for individual character portraits first (preferred for IP-Adapter)
    style_ref_key = f"runs/{run_id}/references/style-reference.png"
    sagemaker_endpoint = os.environ.get("SAGEMAKER_ENDPOINT", "rit-sdxl-ip-adapter")

    # Collect individual character portrait references
    char_portrait_keys = []
    for char_name in characters_in_shot:
        safe_name = re.sub(r"[^a-z0-9]+", "-", char_name.lower()).strip("-")
        portrait_key = f"runs/{run_id}/references/char-{safe_name}.png"
        if s3_exists(portrait_key):
            char_portrait_keys.append(portrait_key)
            logger.info(f"SD3.5 Shot {shot_index}: Found portrait for '{char_name}' at {portrait_key}")

    # Fallback: check for legacy group character sheet
    char_sheet_key = f"runs/{run_id}/references/character-sheet.png"
    has_char_sheet = s3_exists(char_sheet_key) if not char_portrait_keys else False
    has_style_ref = s3_exists(style_ref_key)
    has_individual_portraits = len(char_portrait_keys) > 0

    if has_individual_portraits or has_char_sheet or has_style_ref:
        try:
            sm_payload = {
                "prompt": prompt,
                "negative_prompt": "blurry, grainy, low quality, poorly drawn face, mutated, deformed, text, watermark, words, labels, multiple people standing in a row, character sheet, reference sheet, abstract, hologram, glowing lines, digital interface, floating UI, sci-fi elements",
                "num_inference_steps": 30,
                "guidance_scale": 7.5,
                "width": 1280,
                "height": 720,
                "seed": 0,
            }

            # Strategy: Pass individual portraits as reference_images list
            # IP-Adapter will average their embeddings for multi-character scenes
            # For single character: scale 0.7 (strong identity lock)
            # For multi-character: scale 0.55 (balanced, avoids face merging)
            # For style-only: scale 0.4 (subtle influence)
            if has_individual_portraits:
                reference_images_b64 = []
                for pk in char_portrait_keys:
                    pdata, _ = s3_get(pk)
                    reference_images_b64.append(base64.b64encode(pdata).decode())

                sm_payload["reference_images"] = reference_images_b64

                # Scale based on number of characters
                if len(char_portrait_keys) == 1:
                    sm_payload["ip_adapter_scale"] = 0.8  # Strong single-character identity lock
                elif len(char_portrait_keys) == 2:
                    sm_payload["ip_adapter_scale"] = 0.6  # Balanced for 2 characters
                else:
                    sm_payload["ip_adapter_scale"] = 0.5  # Lighter for 3+ (avoid merging)

                # Also add style reference if available
                if has_style_ref:
                    style_data, _ = s3_get(style_ref_key)
                    sm_payload["style_reference_image"] = base64.b64encode(style_data).decode()

                logger.info(f"SD3.5 Shot {shot_index}: Sending {len(char_portrait_keys)} individual portrait(s) to SageMaker (scale={sm_payload['ip_adapter_scale']})")

            elif has_char_sheet and has_style_ref:
                # Legacy fallback: group sheet + style
                char_data, _ = s3_get(char_sheet_key)
                style_data, _ = s3_get(style_ref_key)
                sm_payload["reference_image"] = base64.b64encode(char_data).decode()
                sm_payload["style_reference_image"] = base64.b64encode(style_data).decode()
                sm_payload["ip_adapter_scale"] = 0.5
                logger.info(f"SD3.5 Shot {shot_index}: Legacy mode — group sheet + style reference")
            elif has_char_sheet:
                char_data, _ = s3_get(char_sheet_key)
                sm_payload["reference_image"] = base64.b64encode(char_data).decode()
                sm_payload["ip_adapter_scale"] = 0.55
                logger.info(f"SD3.5 Shot {shot_index}: Legacy mode — group sheet only")
            else:
                # Style reference only — no character identity
                style_data, _ = s3_get(style_ref_key)
                sm_payload["style_reference_image"] = base64.b64encode(style_data).decode()
                sm_payload["ip_adapter_scale"] = 0.4
                logger.info(f"SD3.5 Shot {shot_index}: Style reference only (no characters)")

            sm_runtime = boto3.client("sagemaker-runtime", region_name="us-east-1")
            response = sm_runtime.invoke_endpoint(
                EndpointName=sagemaker_endpoint,
                ContentType="application/json",
                Body=json.dumps(sm_payload),
            )
            result = json.loads(response["Body"].read())
            # HuggingFace DLC returns [prediction_json, content_type] — unwrap
            if isinstance(result, list):
                result = json.loads(result[0]) if result else {}

            if "image" in result:
                image_bytes = base64.b64decode(result["image"])
                s3_put(key, image_bytes, "image/jpeg")
                ref_count = result.get("reference_count", 1)
                ref_sources = result.get("reference_sources", [])
                logger.info(f"SD3.5 Shot {shot_index}: Generated via SageMaker IP-Adapter ({ref_count} refs: {ref_sources})")
                return respond(200, {"image_url": presigned_url(key), "image_key": key, "shot_index": shot_index, "model_used": "sdxl-ip-adapter"})
            else:
                logger.warning(f"SageMaker returned no image: {result.get('error', 'unknown')}")
        except Exception as e:
            logger.warning(f"SageMaker IP-Adapter failed for shot {shot_index}: {e}. Falling back to Bedrock Style Guide.")

    # Fallback: Bedrock SD3.5 Style Guide
    # Check for style reference to use with Style Guide (NOT character sheet — that causes bleed)
    reference_image_b64 = None
    # Only use the style reference for SD3.5 Style Guide — character sheet causes composition bleed
    if has_style_ref or s3_exists(style_ref_key):
        try:
            ref_data, _ = s3_get(style_ref_key)
            reference_image_b64 = base64.b64encode(ref_data).decode()
            logger.info(f"SD3.5 Shot {shot_index}: Using Style Guide with style reference")
        except Exception as e:
            logger.warning(f"SD3.5: Could not load style reference: {e}")

    try:
        if reference_image_b64:
            # Use Style Guide service — transfers color palette and artistic style (NOT characters)
            # Low fidelity to avoid overwhelming the prompt with style
            sd_body = json.dumps({
                "image": reference_image_b64,
                "prompt": prompt,
                "negative_prompt": "blurry, grainy, pixelated, overexposed, low quality, poorly drawn face, mutated, deformed, disfigured, extra limbs, extra fingers, missing arms, disjointed, text, logo, watermark, words, letters, labels, signs, captions, banners, writing, multiple people standing in a row, character sheet",
                "output_format": "jpeg",
                "aspect_ratio": "16:9",
                "fidelity": 0.35,  # Low fidelity — subtle style influence, prompt drives content
            })
            # Try us-west-2 first, fall back to us-east-1
            try:
                resp = bedrock_west.invoke_model(
                    modelId="us.stability.stable-image-style-guide-v1:0",
                    contentType="application/json",
                    accept="application/json",
                    body=sd_body,
                )
            except Exception:
                resp = bedrock.invoke_model(
                    modelId="us.stability.stable-image-style-guide-v1:0",
                    contentType="application/json",
                    accept="application/json",
                    body=sd_body,
                )
        else:
            # Standard text-to-image (no reference available)
            logger.info(f"SD3.5 Shot {shot_index}: No reference image, using text-to-image")
            sd_body = json.dumps({
                "prompt": prompt,
                "negative_prompt": "blurry, grainy, pixelated, overexposed, low quality, poorly drawn face, mutated, deformed, disfigured, extra limbs, extra fingers, missing arms, disjointed, text, logo, watermark, words, letters, labels, signs, captions, banners, writing",
                "output_format": "jpeg",
                "aspect_ratio": "16:9",
            })
            resp = bedrock_west.invoke_model(
                modelId="stability.sd3-5-large-v1:0",
                contentType="application/json",
                accept="application/json",
                body=sd_body,
            )

        result = json.loads(resp["body"].read())
        images = result.get("images", [])
        if images:
            image_bytes = base64.b64decode(images[0])
            s3_put(key, image_bytes, "image/jpeg")
            return respond(200, {"image_url": presigned_url(key), "image_key": key, "shot_index": shot_index, "model_used": "sd35"})
        return respond(500, {"detail": "No image generated"})
    except Exception as e:
        logger.exception(f"SD3.5 image generation failed for shot {shot_index}")
        return respond(500, {"detail": str(e)})


def _call_gemini_image(prompt, reference_images=None, timeout=120, max_retries=2):
    """
    Core Gemini image generation. Returns image bytes or None.
    reference_images: list of dicts with {"data": base64_str, "mimeType": "image/png"}
    Retries on timeout/transient errors before giving up.
    """
    import urllib.request
    import urllib.error
    import time as _time

    gemini_key = get_gemini_api_key()
    if not gemini_key:
        return None

    model = "gemini-3.1-flash-image-preview"
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"

    # Build parts: reference images first, then text prompt
    parts = []
    if reference_images:
        for ref in reference_images:
            parts.append({"inlineData": {"mimeType": ref["mimeType"], "data": ref["data"]}})
    parts.append({"text": prompt})

    request_body = json.dumps({
        "contents": [{"parts": parts}],
    }).encode()

    last_error = None
    for attempt in range(max_retries + 1):
        req = urllib.request.Request(
            url,
            data=request_body,
            headers={
                "Content-Type": "application/json",
                "x-goog-api-key": gemini_key,
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                result = json.loads(resp.read())

            if result.get("candidates"):
                for part in result["candidates"][0].get("content", {}).get("parts", []):
                    if "inlineData" in part and part["inlineData"].get("mimeType", "").startswith("image/"):
                        return base64.b64decode(part["inlineData"]["data"])

            logger.warning(f"No image in Gemini response (attempt {attempt+1}). Parts: {[list(p.keys()) for p in result.get('candidates', [{}])[0].get('content', {}).get('parts', [])] if result.get('candidates') else 'none'}")
            # No image but no exception — retry may help
            last_error = "no image in response"
        except Exception as e:
            last_error = str(e)
            logger.warning(f"Gemini API call failed (attempt {attempt+1}/{max_retries+1}): {e}")

        # Backoff before retry (skip after last attempt)
        if attempt < max_retries:
            _time.sleep(2 * (attempt + 1))

    logger.error(f"Gemini image generation failed after {max_retries+1} attempts: {last_error}")
    return None


def _generate_image_nova(shot_index, prompt, filename, run_id="default"):
    """Generate a shot image via Amazon Nova Canvas, using reference images if available."""
    key = f"runs/{run_id}/images/{filename}.png"

    # Nova Canvas supports conditioning images for style/composition guidance
    # Load character sheet and style reference if available
    reference_image_b64 = None
    char_sheet_key = f"runs/{run_id}/references/character-sheet.png"
    style_ref_key = f"runs/{run_id}/references/style-reference.png"

    # Prefer character sheet as the conditioning image (has characters + style)
    if s3_exists(char_sheet_key):
        try:
            ref_data, _ = s3_get(char_sheet_key)
            reference_image_b64 = base64.b64encode(ref_data).decode()
            # Prepend reference instruction to prompt
            prompt = f"Using the character designs from the reference image, generate: {prompt}"
            logger.info(f"Nova Shot {shot_index}: Using character sheet as reference")
        except Exception as e:
            logger.warning(f"Nova: Could not load character sheet: {e}")
    elif s3_exists(style_ref_key):
        try:
            ref_data, _ = s3_get(style_ref_key)
            reference_image_b64 = base64.b64encode(ref_data).decode()
            logger.info(f"Nova Shot {shot_index}: Using style reference")
        except Exception as e:
            logger.warning(f"Nova: Could not load style reference: {e}")

    # Also check for user reference images — use first one as conditioning if no char sheet
    if not reference_image_b64:
        user_refs = s3_list(f"runs/{run_id}/references/user-ref-")
        if user_refs:
            try:
                ref_data, _ = s3_get(user_refs[0]["Key"])
                reference_image_b64 = base64.b64encode(ref_data).decode()
                logger.info(f"Nova Shot {shot_index}: Using user reference as conditioning")
            except Exception:
                pass

    try:
        # Nova Canvas API via Bedrock (amazon.nova-canvas-v1:0 is the latest version)
        # Supports style presets: 3D_ANIMATED_FAMILY_FILM, FLAT_VECTOR_ILLUSTRATION,
        # GRAPHIC_NOVEL_ILLUSTRATION, SOFT_DIGITAL_PAINTING, PHOTOREALISM, etc.
        nova_body = {
            "taskType": "TEXT_IMAGE",
            "textToImageParams": {
                "text": prompt,
                "negativeText": "blurry, low quality, distorted, watermark, text overlay, words, labels, cropped, partial body, extra limbs, deformed",
            },
            "imageGenerationConfig": {
                "numberOfImages": 1,
                "width": 1280,
                "height": 720,
                "cfgScale": 7.0,
                "quality": "premium",
            },
        }

        # If we have a reference image, use IMAGE_VARIATION task instead for style consistency
        if reference_image_b64:
            nova_body = {
                "taskType": "IMAGE_VARIATION",
                "imageVariationParams": {
                    "text": prompt,
                    "negativeText": "blurry, low quality, distorted, watermark, text overlay, words, labels, cropped, deformed",
                    "images": [reference_image_b64],
                    "similarityStrength": 0.3,  # Low similarity — prompt drives content, ref drives style
                },
                "imageGenerationConfig": {
                    "numberOfImages": 1,
                    "width": 1280,
                    "height": 720,
                    "cfgScale": 7.0,
                    "quality": "premium",
                },
            }

        # Nova Canvas is available in us-east-1
        resp = bedrock.invoke_model(
            modelId="amazon.nova-canvas-v1:0",
            contentType="application/json",
            accept="application/json",
            body=json.dumps(nova_body),
        )
        result = json.loads(resp["body"].read())
        images = result.get("images", [])
        if images:
            image_bytes = base64.b64decode(images[0])
            s3_put(key, image_bytes, "image/png")
            return respond(200, {"image_url": presigned_url(key), "image_key": key, "shot_index": shot_index, "model_used": "nova"})

        logger.warning(f"Nova Canvas returned no images for shot {shot_index}")
    except Exception as e:
        logger.exception(f"Nova Canvas failed for shot {shot_index}: {e}")

    # Fallback to Gemini if Nova fails
    logger.warning(f"Nova Canvas failed for shot {shot_index}, falling back to Advanced model")
    return _generate_image_gemini(shot_index, prompt, filename, run_id)


def _generate_image_gemini(shot_index, prompt, filename, run_id="default"):
    """Generate a shot image via Gemini, using character sheet and user references if available."""
    key = f"runs/{run_id}/images/{filename}.png"

    # Load character sheet reference if it exists for this run
    reference_images = []
    has_char_sheet = False
    has_style_ref = False
    char_sheet_key = f"runs/{run_id}/references/character-sheet.png"
    if s3_exists(char_sheet_key):
        try:
            char_sheet_data, _ = s3_get(char_sheet_key)
            reference_images.append({
                "data": base64.b64encode(char_sheet_data).decode(),
                "mimeType": "image/png",
            })
            has_char_sheet = True
            logger.info(f"Shot {shot_index}: Loaded character sheet reference ({len(char_sheet_data)} bytes)")
        except Exception as e:
            logger.warning(f"Could not load character sheet for run {run_id}: {e}")

    # Also load style reference if available
    style_ref_key = f"runs/{run_id}/references/style-reference.png"
    if s3_exists(style_ref_key):
        try:
            style_data, _ = s3_get(style_ref_key)
            reference_images.append({
                "data": base64.b64encode(style_data).decode(),
                "mimeType": "image/png",
            })
            has_style_ref = True
            logger.info(f"Shot {shot_index}: Loaded style reference ({len(style_data)} bytes)")
        except Exception as e:
            logger.warning(f"Could not load style reference for run {run_id}: {e}")

    # Build instruction prefix based on what references are available.
    # The style reference is AUTHORITATIVE — it must override any medium words
    # (e.g. "photography") that may appear in the scene description, otherwise
    # the rendering drifts to realism and loses the chosen (e.g. anime) style.
    style_lock = ("IMPORTANT: The art style, rendering technique, color palette, and level of "
                  "realism MUST exactly match the STYLE REFERENCE image. If the scene text below "
                  "mentions a medium like 'photography', 'photo', or 'realistic', IGNORE those words "
                  "and render in the reference's art style instead. ")

    # Keep any in-image text clean and consistent across shots
    text_lock = ("TEXT RULE: If this scene contains any visible text (signs, screens, labels, UI), "
                 "render it in ONE consistent clean sans-serif font, as plain text sitting directly "
                 "on the scene. Do NOT add a banner, box, ribbon, highlight, or colored background "
                 "behind the text. Keep wording short and legible. ")

    if has_char_sheet and has_style_ref:
        prompt = (f"You are given two reference images. The FIRST is a CHARACTER REFERENCE — match the "
                  f"character appearances exactly. The SECOND is a STYLE REFERENCE — match its art style, "
                  f"colors, line work, and rendering exactly. {style_lock}{text_lock}Generate this scene: {prompt}")
    elif has_char_sheet:
        prompt = (f"Using the attached character sheet as a visual reference, match the character "
                  f"appearances AND the art style/rendering shown in it exactly. {style_lock}{text_lock}"
                  f"Generate this scene: {prompt}")
    elif has_style_ref:
        prompt = (f"Using the attached image as a STYLE REFERENCE, match its art style, colors, and "
                  f"rendering exactly. {style_lock}{text_lock}Generate this scene: {prompt}")
    else:
        prompt = f"{text_lock}Generate this scene: {prompt}"

    # Load user-uploaded reference images (logos, scenery, etc.)
    user_refs = s3_list(f"runs/{run_id}/references/user-ref-")
    for obj in user_refs[:5]:  # Limit to 5 to avoid overwhelming the model
        try:
            ref_data, _ = s3_get(obj["Key"])
            reference_images.append({
                "data": base64.b64encode(ref_data).decode(),
                "mimeType": "image/png",
            })
            logger.info(f"Shot {shot_index}: Loaded user reference ({obj['Key'].split('/')[-1]})")
        except Exception as e:
            logger.warning(f"Could not load user reference {obj['Key']}: {e}")

    image_bytes = _call_gemini_image(prompt, reference_images if reference_images else None)

    if image_bytes:
        s3_put(key, image_bytes, "image/png")
        return respond(200, {"image_url": presigned_url(key), "image_key": key, "shot_index": shot_index, "model_used": "gemini"})

    # Fallback to SD3.5
    logger.warning(f"Gemini failed for shot {shot_index}, falling back to SD3.5")
    return _generate_image_sd35(shot_index, prompt, filename, run_id)


# ── Generate Audio (Nova Sonic TTS via Bedrock bidirectional streaming) ──
def handle_generate_audio(event):
    body = parse_json_body(event)
    shot_index = body.get("shot_index", 0)
    text = body.get("text", "")
    run_id = body.get("run_id", "default")
    if not text:
        return respond(400, {"detail": "text is required"})

    # The narration language decides which voice can read it. Resolving here means
    # a stale English voice saved on a French project is corrected rather than
    # reading French text with English phonetics.
    language = normalize_language(body.get("language") or get_run_language(run_id))
    voice_id = resolve_voice(body.get("voice_id", ""), language)["id"]

    import asyncio
    filename = f"vo-shot-{shot_index + 1:02d}-{uuid.uuid4().hex[:8]}.wav"
    key = f"runs/{run_id}/audio/{filename}"

    # Synthesis of more than a short clip can exceed API Gateway's 29s limit
    # (a single Nova Sonic session reads in ~real time). For anything beyond a
    # couple of sentences, run asynchronously (self-invoke) and return a job_id.
    word_count = len(text.split())
    if word_count > 60:
        job_id = f"audio-{uuid.uuid4().hex[:12]}"
        status_key = f"audio-jobs/{job_id}.json"
        s3_put(status_key, json.dumps({
            "job_id": job_id, "status": "processing", "shot_index": shot_index,
            "detail": status_message("generating_audio", language), "language": language,
        }).encode(), "application/json")
        lambda_client.invoke(
            FunctionName=SELF_FUNCTION_NAME,
            InvocationType="Event",
            Payload=json.dumps({
                "_async_task": "generate_audio",
                "job_id": job_id, "shot_index": shot_index,
                "text": text, "voice_id": voice_id, "run_id": run_id, "key": key,
                "language": language,
            }).encode(),
        )
        return respond(200, {"async": True, "job_id": job_id, "shot_index": shot_index})

    # Short text — synthesize synchronously (fast, fits in the request window)
    try:
        pcm_data = asyncio.get_event_loop().run_until_complete(
            nova_sonic_synthesize_long(text, voice_id, language=language)
        )
    except RuntimeError:
        pcm_data = asyncio.run(nova_sonic_synthesize_long(text, voice_id, language=language))

    if pcm_data:
        wav_bytes = _pcm_to_wav(pcm_data, shot_index)
        s3_put(key, wav_bytes, "audio/wav")
        return respond(200, {"audio_url": presigned_url(key), "audio_key": key,
                             "shot_index": shot_index, "voice_id": voice_id})

    # Fallback to Polly if Nova Sonic fails
    logger.warning(f"Nova Sonic failed for shot {shot_index}, falling back to Polly")
    return _polly_fallback(text, shot_index, voice_id, key, language)


def _pcm_to_wav(pcm_data, shot_index):
    """Wrap raw PCM as a WAV container.

    No trimming happens here. Duplicate readings are prevented by the single-read
    instruction in the Nova Sonic prompt and, if the model disobeys, removed by
    _drop_repeated_reading using the transcript as evidence.

    The previous version trimmed to a word-count duration estimate, which both failed
    to catch doubling (its 2.2x allowance exceeded a 2x repeat) and risked truncating
    legitimately slow or heavily punctuated narration.

    Args:
        pcm_data: Raw 24 kHz mono 16-bit PCM.
        shot_index: Shot index, for logging only.

    Returns:
        WAV bytes.
    """
    import wave

    sample_rate = 24000
    logger.info(f"Shot {shot_index}: writing {len(pcm_data)/(sample_rate*2):.1f}s of narration")
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sample_rate)
        wf.writeframes(pcm_data)
    return buf.getvalue()


def _async_generate_audio(payload):
    """Async worker: synthesize (possibly long, chunked) audio and store result."""
    import asyncio
    job_id = payload["job_id"]
    text = payload.get("text", "")
    shot_index = payload.get("shot_index", 0)
    key = payload.get("key", "")
    status_key = f"audio-jobs/{job_id}.json"
    language = normalize_language(payload.get("language"))
    voice_id = resolve_voice(payload.get("voice_id", ""), language)["id"]

    try:
        try:
            pcm_data = asyncio.get_event_loop().run_until_complete(
                nova_sonic_synthesize_long(text, voice_id, language=language)
            )
        except RuntimeError:
            pcm_data = asyncio.run(nova_sonic_synthesize_long(text, voice_id, language=language))

        if pcm_data:
            wav_bytes = _pcm_to_wav(pcm_data, shot_index)
            s3_put(key, wav_bytes, "audio/wav")
            s3_put(status_key, json.dumps({
                "job_id": job_id, "status": "complete", "shot_index": shot_index,
                "audio_key": key, "audio_url": presigned_url(key),
            }).encode(), "application/json")
            logger.info(f"Async audio job {job_id} complete ({len(wav_bytes)} bytes)")
        else:
            # Polly fallback (synchronous, single shot)
            fb = _polly_fallback(text, shot_index, voice_id, key, language)
            fb_body = json.loads(fb.get("body", "{}"))
            if fb_body.get("audio_url"):
                s3_put(status_key, json.dumps({
                    "job_id": job_id, "status": "complete", "shot_index": shot_index,
                    "audio_key": fb_body.get("audio_url", ""), "audio_url": fb_body["audio_url"],
                }).encode(), "application/json")
            else:
                raise RuntimeError("No audio produced")
    except Exception as e:
        logger.exception(f"Async audio job {job_id} failed: {e}")
        s3_put(status_key, json.dumps({
            "job_id": job_id, "status": "error", "shot_index": shot_index, "detail": str(e),
        }).encode(), "application/json")


def handle_audio_status(event):
    """Poll an async audio generation job."""
    body = parse_json_body(event)
    job_id = body.get("job_id", "")
    if not job_id:
        return respond(400, {"detail": "job_id is required"})
    status_key = f"audio-jobs/{job_id}.json"
    if not s3_exists(status_key):
        return respond(404, {"detail": "Audio job not found"})
    data, _ = s3_get(status_key)
    return respond(200, json.loads(data))


# ── AI Help (image prompt refinement) ──
def handle_ai_help(event):
    body = parse_json_body(event)
    shot_index = body.get("shot_index", 0)
    current_prompt = body.get("current_prompt", "")
    guidance = body.get("guidance", "")
    style_override = body.get("style_override", "")

    if not guidance:
        return respond(400, {"detail": "guidance is required"})

    # Image prompts stay English regardless of project language — the note below
    # is appended for French projects so a French guidance message still yields an
    # English prompt.
    language = normalize_language(body.get("language"))
    language_note = (
        "\n\nThe user may write their guidance in French. Understand it, but ALWAYS return the "
        "rewritten prompt in ENGLISH — it is sent to an image-generation model."
        if language != "en" else ""
    )

    system = """You are an image prompt engineer for a storyboard tool.

CRITICAL RULES:
- A style reference IMAGE and character reference IMAGE are passed separately to the image model.
- Your prompt must focus ONLY on: scene composition, character actions/poses, environment, lighting, and camera angle.
- Do NOT describe the visual style (colors, line work, rendering technique) — the style image handles that.
- Do NOT describe character appearance in detail (hair color, eye color, skin tone, clothing details) — the character sheet handles that.
- Keep the prompt SHORT (under 250 characters). Shorter = more consistent results.
- Start with a very brief style tag (max 5 words like "pastel cartoon style") then describe the SCENE.
- Focus on: WHO is doing WHAT, WHERE, camera angle, lighting.

GOOD example: "Pastel cartoon style, a woman and two children walking through an autumn park holding hands, warm golden light, wide shot"
BAD example: "Vibrant modern cartoon vector illustration style with clean lineart, featuring saturated colors including warm reds and teals..." (TOO VERBOSE, describes style that the image handles)

Return ONLY the rewritten prompt text, nothing else.""" + language_note

    new_prompt = call_claude(system, f"Current prompt:\n{current_prompt}\n\nUser guidance:\n{guidance}")
    return respond(200, {"new_prompt": new_prompt.strip(), "shot_index": shot_index})


# ── AI Help Narration ──
def handle_ai_help_narration(event):
    body = parse_json_body(event)
    current_narration = body.get("current_narration", "")
    guidance = body.get("guidance", "")
    narrative_style = body.get("narrative_style", "")

    if not guidance:
        return respond(400, {"detail": "guidance is required"})

    # Narration is read aloud to the audience, so unlike image prompts it must be
    # in the project language.
    language = normalize_language(body.get("language") or get_run_language(body.get("run_id", "")))
    system = f"""You are a narration scriptwriter. Rewrite the narration based on the user's guidance.
Keep it warm, professional, engaging. Under 200 characters. Return ONLY the new narration text.
Narrative style direction: {narrative_style}
{language_directive(language)}"""

    new_narration = call_claude(system, f"Current narration:\n{current_narration}\n\nUser guidance:\n{guidance}")
    return respond(200, {"new_narration": new_narration.strip(), "language": language})


# ── Voices ──
def handle_voices(event):
    """List the narration voices available for a language.

    The language comes from the ?language= query parameter so the console can
    refresh the picker the moment the user switches language, before any project
    exists to read it from.
    """
    params = event.get("queryStringParameters") or {}
    language = normalize_language(params.get("language"))
    descriptions = VOICE_DESCRIPTIONS.get(language, VOICE_DESCRIPTIONS["en"])

    voices = []
    for entry in VOICE_CATALOG[language]:
        voices.append({
            "id": entry["id"],
            "name": entry["name"],
            "gender": entry["gender"],
            "desc": descriptions.get(entry["id"], ""),
            # Samples are cached per language: the same voice reads a different
            # script in each language.
            "has_sample": s3_exists(f"voice-samples/{language}/sample-{entry['id']}.mp3"),
        })
    return respond(200, {"voices": voices, "language": language})


# ── Voice Sample ──
def handle_voice_sample(event):
    """Return a short spoken preview of a voice, generating and caching on demand."""
    params = event.get("queryStringParameters") or {}
    language = normalize_language(params.get("language"))
    voice = resolve_voice(path_param(event, "voice_id"), language)
    voice_id = voice["id"]
    sample_text = VOICE_SAMPLE_TEXT[language].format(name=voice["name"])

    key = f"voice-samples/{language}/sample-{voice_id}.wav"
    if s3_exists(key):
        return respond(200, {"audio_url": presigned_url(key), "language": language})

    # Generate with Nova Sonic
    import asyncio
    try:
        pcm_data = asyncio.run(nova_sonic_synthesize(sample_text, voice_id, language=language))
        if pcm_data:
            import wave
            buf = io.BytesIO()
            with wave.open(buf, "wb") as wf:
                wf.setnchannels(1)
                wf.setsampwidth(2)
                wf.setframerate(24000)
                wf.writeframes(pcm_data)
            s3_put(key, buf.getvalue(), "audio/wav")
            return respond(200, {"audio_url": presigned_url(key), "language": language})
    except Exception:
        logger.exception(f"Nova Sonic voice sample failed for {voice_id} ({language})")

    # Fallback to Polly, using the voice mapped for this language.
    polly_voice = voice["polly"]
    try:
        resp = polly.synthesize_speech(
            Text=sample_text, OutputFormat="mp3", VoiceId=polly_voice, Engine="generative",
        )
        mp3_key = f"voice-samples/{language}/sample-{voice_id}.mp3"
        s3_put(mp3_key, resp["AudioStream"].read(), "audio/mpeg")
        return respond(200, {"audio_url": presigned_url(mp3_key), "language": language})
    except ClientError as e:
        logger.exception(f"Voice sample failed for {voice_id} ({language}) via Polly voice {polly_voice}")
        return respond(500, {"detail": str(e)})


# ── Play Voice Sample ──
def handle_play_voice_sample(event):
    voice_id = path_param(event, "voice_id")
    params = event.get("queryStringParameters") or {}
    language = normalize_language(params.get("language"))
    key = f"voice-samples/{language}/sample-{voice_id}.mp3"
    if not s3_exists(key):
        return respond(404, {"detail": "Sample not found"})
    # Return the audio bytes directly
    data, ct = s3_get(key)
    return {
        "statusCode": 200,
        "headers": {
            "Content-Type": "audio/mpeg",
            "Access-Control-Allow-Origin": "*",
        },
        "body": base64.b64encode(data).decode(),
        "isBase64Encoded": True,
    }


# ── Analyze Style Image (Claude Vision) ──
def handle_analyze_style(event):
    if is_multipart(event):
        file_data, filename, ct = parse_multipart(event)
        if not file_data:
            return respond(400, {"detail": "No file uploaded"})
        image_bytes = file_data
        fmt = "jpeg" if "jpeg" in ct or "jpg" in (filename or "").lower() else "png"
    else:
        body = parse_json_body(event)
        image_b64 = body.get("image", "")
        if not image_b64:
            return respond(400, {"detail": "image is required"})
        image_bytes = base64.b64decode(image_b64)
        fmt = body.get("media_type", "image/png").split("/")[-1]

    try:
        response = bedrock.converse(
            modelId=CLAUDE_MODEL_ID,
            messages=[{
                "role": "user",
                "content": [
                    {"image": {"format": fmt, "source": {"bytes": image_bytes}}},
                    {"text": "Analyze the visual style of this image for use as a reference style in AI image generation. START with the art medium/style in 2-4 words (e.g. 'anime illustration', '2D flat cartoon', 'watercolor painting', '3D rendered', 'photorealistic photography'). Then describe the color palette, line work, shapes, texture, lighting, mood, and composition in a single paragraph that can be appended to image generation prompts. Be specific and concise. If the image is clearly a drawing, cartoon, anime, or illustration, do NOT describe it as 'photography' or 'realistic'. Return ONLY the style description paragraph, nothing else."},
                ],
            }],
            inferenceConfig={"maxTokens": 1024},
        )
        style = extract_converse_text(response)
        return respond(200, {"style": style.strip()})
    except Exception as e:
        logger.exception("Style analysis failed")
        return respond(500, {"detail": str(e)})


# ── Delete Music / Wallpaper ──
def handle_delete_music(event):
    """Delete a background music track from S3."""
    body = parse_json_body(event)
    filename = (body.get("filename") or "").strip()
    if not filename:
        return respond(400, {"detail": "filename is required"})
    # Guard against path traversal — only operate within music/
    safe = filename.split("/")[-1]
    key = f"music/{safe}"
    try:
        s3.delete_object(Bucket=ASSETS_BUCKET, Key=key)
        logger.info(f"Deleted music track: {key}")
        return respond(200, {"deleted": safe})
    except Exception as e:
        logger.warning(f"Failed to delete music {key}: {e}")
        return respond(500, {"detail": str(e)})


def handle_delete_wallpaper(event):
    """Delete a wallpaper image from S3."""
    body = parse_json_body(event)
    filename = (body.get("filename") or "").strip()
    if not filename:
        return respond(400, {"detail": "filename is required"})
    safe = filename.split("/")[-1]
    key = f"wallpapers/{safe}"
    try:
        s3.delete_object(Bucket=ASSETS_BUCKET, Key=key)
        logger.info(f"Deleted wallpaper: {key}")
        return respond(200, {"deleted": safe})
    except Exception as e:
        logger.warning(f"Failed to delete wallpaper {key}: {e}")
        return respond(500, {"detail": str(e)})


# ── Music Tracks ──
def handle_music_tracks(event):
    objects = s3_list("music/")
    tracks = []
    for o in objects:
        fname = o["Key"].split("/")[-1]
        if fname.endswith((".mp3", ".wav", ".m4a", ".ogg")):
            name = fname.rsplit(".", 1)[0].replace("-", " ").replace("_", " ")
            tracks.append({"name": name, "file": fname, "preview_url": presigned_url(o["Key"])})
    return respond(200, {"tracks": tracks})


# ── Upload Music ──
def handle_upload_music(event):
    """Upload music — supports both direct multipart (small files) and presigned URL flow."""
    # Check if this is a request for a presigned upload URL
    if not is_multipart(event):
        body = parse_json_body(event)
        filename = body.get("filename", "")
        content_type = body.get("content_type", "audio/mpeg")
        if filename:
            # Return a presigned PUT URL for direct S3 upload (bypasses 6MB API Gateway limit)
            key = f"music/{filename}"
            presigned = s3.generate_presigned_url(
                "put_object",
                Params={"Bucket": ASSETS_BUCKET, "Key": key, "ContentType": content_type},
                ExpiresIn=300,
            )
            name = filename.rsplit(".", 1)[0].replace("-", " ").replace("_", " ")
            return respond(200, {"upload_url": presigned, "name": name, "file": filename})
        return respond(400, {"detail": "filename is required for presigned upload, or use multipart"})

    # Direct multipart upload (works for files under ~4.5MB after base64 inflation)
    file_data, filename, ct = parse_multipart(event)
    if not file_data:
        return respond(400, {"detail": "No file uploaded"})
    key = f"music/{filename}"
    s3_put(key, file_data, ct)
    name = filename.rsplit(".", 1)[0].replace("-", " ").replace("_", " ")
    return respond(200, {"name": name, "file": filename})


# ── Preview Music ──
def handle_preview_music(event):
    filename = path_param(event, "filename")
    key = f"music/{filename}"
    if not s3_exists(key):
        return respond(404, {"detail": "Not found"})
    data, ct = s3_get(key)
    return {
        "statusCode": 200,
        "headers": {"Content-Type": ct or "audio/mpeg", "Access-Control-Allow-Origin": "*"},
        "body": base64.b64encode(data).decode(),
        "isBase64Encoded": True,
    }


# ── Wallpapers ──
def handle_wallpapers(event):
    results = []
    for prefix in ["wallpapers/"]:
        for o in s3_list(prefix):
            fname = o["Key"].split("/")[-1]
            if fname.endswith((".jpg", ".jpeg", ".png", ".webp")):
                name = fname.rsplit(".", 1)[0].replace("-", " ").replace("_", " ")
                source = "s3"
                results.append({"name": name, "file": fname, "source": source, "preview_url": presigned_url(o["Key"])})
    return respond(200, {"wallpapers": results})


# ── Upload Wallpaper ──
def handle_upload_wallpaper(event):
    """Upload wallpaper — supports both direct multipart (small files) and presigned URL flow."""
    if not is_multipart(event):
        body = parse_json_body(event)
        filename = body.get("filename", "")
        content_type = body.get("content_type", "image/jpeg")
        if filename:
            key = f"wallpapers/{filename}"
            presigned = s3.generate_presigned_url(
                "put_object",
                Params={"Bucket": ASSETS_BUCKET, "Key": key, "ContentType": content_type},
                ExpiresIn=300,
            )
            return respond(200, {"upload_url": presigned, "key": key, "name": filename, "file": filename})
        return respond(400, {"detail": "filename is required for presigned upload, or use multipart"})

    file_data, filename, ct = parse_multipart(event)
    if not file_data:
        return respond(400, {"detail": "No file uploaded"})
    key = f"wallpapers/{filename}"
    s3_put(key, file_data, ct)
    return respond(200, {"name": filename, "file": filename})


# ── Preview Wallpaper ──
def handle_preview_wallpaper(event):
    source = path_param(event, "source")
    filename = path_param(event, "filename")
    key = f"wallpapers/{source}/{filename}" if source != "s3" else f"wallpapers/{filename}"
    if not s3_exists(key):
        # Try without source prefix
        key = f"wallpapers/{filename}"
        if not s3_exists(key):
            return respond(404, {"detail": "Not found"})
    data, ct = s3_get(key)
    return {
        "statusCode": 200,
        "headers": {"Content-Type": ct or "image/jpeg", "Access-Control-Allow-Origin": "*"},
        "body": base64.b64encode(data).decode(),
        "isBase64Encoded": True,
    }


# ── Create Video ──
def handle_create_video(event):
    body = parse_json_body(event)
    run_id = body.get("run_id") or datetime.now(timezone.utc).strftime("%Y-%m-%dT%H-%M-%S")
    shots = body.get("shots", [])
    if not shots:
        return respond(400, {"detail": "shots is required"})

    # Transform shots into clips format for the merge Lambda
    # Support both image shots (image_url/image_key) and video shots (video_key)
    clips = []
    for shot in shots:
        video_key = ""
        audio_key = ""

        # Check for direct S3 keys first (preferred — set by frontend for video shots and synced shots)
        if shot.get("video_key"):
            video_key = shot["video_key"]
        elif shot.get("image_key"):
            video_key = shot["image_key"]
        elif shot.get("image_url"):
            # Fallback: extract S3 key from presigned URL
            image_url = shot["image_url"]
            path_part = image_url.split("?")[0]
            if ".amazonaws.com/" in path_part:
                video_key = path_part.split(".amazonaws.com/", 1)[-1]
            elif "/" in path_part:
                video_key = path_part.split("/", 3)[-1] if path_part.count("/") >= 3 else ""

        # Audio key
        if shot.get("audio_mode") == "native":
            # Native audio: don't pass a separate audio key — merge Lambda will use embedded audio
            audio_key = ""
        elif shot.get("audio_key"):
            audio_key = shot["audio_key"]
        elif shot.get("audio_url"):
            audio_url = shot["audio_url"]
            path_part = audio_url.split("?")[0]
            if ".amazonaws.com/" in path_part:
                audio_key = path_part.split(".amazonaws.com/", 1)[-1]
            elif "/" in path_part:
                audio_key = path_part.split("/", 3)[-1] if path_part.count("/") >= 3 else ""

        if video_key:
            clip_entry = {"video_key": video_key, "audio_key": audio_key}
            # Pass audio_mode so merge Lambda knows whether to keep native audio
            if shot.get("audio_mode"):
                clip_entry["audio_mode"] = shot["audio_mode"]
            if shot.get("is_video"):
                clip_entry["is_video"] = True
            clips.append(clip_entry)

    if not clips:
        return respond(400, {"detail": "No valid image/audio assets found in shots"})

    # Get music and wallpaper keys
    music_key = ""
    music_file = body.get("music", "")
    if music_file:
        music_key = f"music/{music_file}"

    wallpaper_key = ""
    wallpaper_file = body.get("wallpaper", "")
    if wallpaper_file:
        wallpaper_key = f"wallpapers/{wallpaper_file}"

    status_key = f"runs/{run_id}/status.json"
    # Collect image and audio keys for the run history
    image_keys = [c["video_key"] for c in clips if c.get("video_key", "").endswith((".jpg", ".jpeg", ".png"))]
    audio_keys = [c["audio_key"] for c in clips if c.get("audio_key")]

    # Write manifest.json — the "database record" for this run
    # Include full shot data so we can restore the storyboard later
    frontend_shots = body.get("shots", [])

    # Music volume from payload, default 0.3 (30%). Clamp to valid range.
    music_volume = body.get("music_volume", 0.3)
    try:
        music_volume = float(music_volume)
    except (TypeError, ValueError):
        music_volume = 0.3
    music_volume = max(0.0, min(1.0, music_volume))

    manifest = {
        "id": run_id,
        "created_at": now_iso(),
        "status": "processing",
        "project_name": body.get("project_name", ""),
        "project_description": body.get("project_description", ""),
        "image_model": body.get("image_model", "sd35"),
        "shots": [
            {
                "index": i,
                "image_key": c.get("video_key", ""),
                "audio_key": c.get("audio_key", ""),
                "video_key": c.get("video_key", "") if c.get("is_video") else "",
                "is_video": c.get("is_video", False),
                "audio_mode": c.get("audio_mode", ""),
                "title": frontend_shots[i].get("title", f"Shot {i+1}") if i < len(frontend_shots) else f"Shot {i+1}",
                "image_prompt": frontend_shots[i].get("image_prompt", "") if i < len(frontend_shots) else "",
                "narration": frontend_shots[i].get("narration", "") if i < len(frontend_shots) else "",
                "characters_in_shot": frontend_shots[i].get("characters_in_shot", []) if i < len(frontend_shots) else [],
            }
            for i, c in enumerate(clips)
        ],
        "settings": body.get("settings", {}),
        "music_key": music_key,
        "music_file": body.get("music", ""),
        "music_volume": music_volume,
        "wallpaper_key": wallpaper_key,
        "wallpaper_file": body.get("wallpaper", ""),
        "video_key": f"runs/{run_id}/output/final.mp4",
    }
    s3_put(f"runs/{run_id}/manifest.json", json.dumps(manifest).encode(), "application/json")

    s3_put(status_key, json.dumps({
        "run_id": run_id, "status": "processing", "started_at": now_iso(),
        "total_clips": len(clips), "progress": 5, "detail": "Starting video assembly...",
        "image_keys": image_keys,
    }).encode(), "application/json")

    # Invoke merge Lambda async
    merge_payload = {
        "run_id": run_id,
        "clips": clips,
        "music_key": music_key if music_key and s3_exists(music_key) else "",
        "wallpaper_key": wallpaper_key if wallpaper_key and s3_exists(wallpaper_key) else "",
        "music_volume": music_volume,
        "music_fade": 5,
        "wallpaper_duration": 3,
        "shot_duration": (body.get("settings") or {}).get("shotDuration", 6),
    }

    try:
        lambda_client.invoke(
            FunctionName=MERGE_FUNCTION_NAME,
            InvocationType="Event",
            Payload=json.dumps(merge_payload).encode(),
        )
        logger.info(f"Merge Lambda invoked for run {run_id} with {len(clips)} clips")
    except Exception as e:
        logger.exception("Failed to invoke merge Lambda")
        return respond(500, {"detail": str(e)})

    return respond(200, {"status": "processing", "job_id": run_id})


# ── Video Status ──
def handle_video_status(event):
    job_id = path_param(event, "job_id")
    key = f"runs/{job_id}/status.json"
    if not s3_exists(key):
        return respond(404, {"detail": "Job not found"})
    data, _ = s3_get(key)
    status = json.loads(data)

    # Add download/preview URLs when complete
    if status.get("status") == "complete" and status.get("output_key"):
        output_key = status["output_key"]
        if s3_exists(output_key):
            status["download_url"] = presigned_url(output_key, expires=7200)
            status["preview_url"] = presigned_url(output_key, expires=7200)
            # Get file size
            try:
                head = s3.head_object(Bucket=ASSETS_BUCKET, Key=output_key)
                status["size_mb"] = round(head["ContentLength"] / (1024 * 1024), 1)
            except Exception:
                pass

    return respond(200, status)


# ── Download Video ──
def handle_download_video(event):
    job_id = path_param(event, "job_id")
    key = f"runs/{job_id}/output/final.mp4"
    if not s3_exists(key):
        return respond(404, {"detail": "Video not ready"})
    return respond(200, {"download_url": presigned_url(key, expires=7200)})


# ── Preview Video ──
def handle_preview_video(event):
    job_id = path_param(event, "job_id")
    key = f"runs/{job_id}/output/final.mp4"
    if not s3_exists(key):
        return respond(404, {"detail": "Video not ready"})
    return respond(200, {"preview_url": presigned_url(key)})


# ── Runs ──
def handle_runs(event):
    paginator = s3.get_paginator("list_objects_v2")
    run_ids = set()
    for page in paginator.paginate(Bucket=ASSETS_BUCKET, Prefix="runs/", Delimiter="/"):
        for p in page.get("CommonPrefixes", []):
            rid = p["Prefix"].replace("runs/", "").rstrip("/")
            if rid:
                run_ids.add(rid)

    runs = []
    for rid in sorted(run_ids, reverse=True):
        status = {"status": "unknown"}
        if s3_exists(f"runs/{rid}/status.json"):
            data, _ = s3_get(f"runs/{rid}/status.json")
            status = json.loads(data)

        # Get images from manifest.json (preferred) or status.json fallback
        manifest_key = f"runs/{rid}/manifest.json"
        image_keys = []
        manifest = {}
        if s3_exists(manifest_key):
            mdata, _ = s3_get(manifest_key)
            manifest = json.loads(mdata)
            image_keys = [s["image_key"] for s in manifest.get("shots", []) if s.get("image_key")]
        else:
            image_keys = status.get("image_keys", [])

        images = [k.split("/")[-1] for k in image_keys]
        image_urls = {}
        for k in image_keys[:16]:
            if k and s3_exists(k):
                image_urls[k.split("/")[-1]] = presigned_url(k)

        # Video presigned URL if complete
        video_url = None
        download_url = None
        output_key = status.get("output_key", f"runs/{rid}/output/final.mp4")
        if status.get("status") == "complete" and s3_exists(output_key):
            video_url = presigned_url(output_key, expires=7200)
            download_url = video_url
            try:
                head = s3.head_object(Bucket=ASSETS_BUCKET, Key=output_key)
                status["size_mb"] = round(head["ContentLength"] / (1024 * 1024), 1)
            except Exception:
                pass

        runs.append({
            "id": rid,
            "date": status.get("started_at", rid),
            "status": status.get("status", "unknown"),
            "project_name": manifest.get("project_name", ""),
            "project_description": manifest.get("project_description", ""),
            "image_count": len(images),
            "images": images[:16],
            "image_urls": image_urls,
            "video_url": video_url,
            "download_url": download_url,
            "size_mb": status.get("size_mb"),
        })

    return respond(200, {"runs": runs})


# ── Get Run Manifest (for restoring storyboard) ──
def handle_get_manifest(event):
    run_id = path_param(event, "run_id")
    if not run_id:
        return respond(400, {"detail": "run_id is required"})

    manifest_key = f"runs/{run_id}/manifest.json"
    if not s3_exists(manifest_key):
        return respond(404, {"detail": "Manifest not found for this run"})

    data, _ = s3_get(manifest_key)
    manifest = json.loads(data)

    # Add presigned URLs for all assets
    for shot in manifest.get("shots", []):
        is_video_shot = shot.get("is_video") or (shot.get("video_key", "").lower().endswith((".mp4", ".mov", ".webm")))
        if is_video_shot:
            # Video shot — presign the video, not as an image
            vkey = shot.get("video_key") or shot.get("image_key")
            if vkey and s3_exists(vkey):
                shot["video_url"] = presigned_url(vkey, expires=7200)
                shot["video_key"] = vkey
            shot["is_video"] = True
            shot["image_url"] = None  # ensure frontend doesn't try to load video as image
        else:
            if shot.get("image_key") and s3_exists(shot["image_key"]):
                shot["image_url"] = presigned_url(shot["image_key"])
        if shot.get("audio_key") and s3_exists(shot["audio_key"]):
            shot["audio_url"] = presigned_url(shot["audio_key"])

    if manifest.get("video_key") and s3_exists(manifest["video_key"]):
        manifest["video_url"] = presigned_url(manifest["video_key"], expires=7200)

    # Include character sheet URL if available
    char_sheet_key = f"runs/{run_id}/references/character-sheet.png"
    if s3_exists(char_sheet_key):
        manifest["character_sheet_url"] = presigned_url(char_sheet_key)

    # If characters not in manifest, try loading from job status or resume payload
    if not manifest.get("characters"):
        # Try job status (has characters when status was characters_ready or complete)
        status_key = f"jobs/{run_id}/status.json"
        if s3_exists(status_key):
            try:
                status_data, _ = s3_get(status_key)
                status_json = json.loads(status_data)
                if status_json.get("characters"):
                    manifest["characters"] = status_json["characters"]
                if status_json.get("art_direction") and not manifest.get("art_direction"):
                    manifest["art_direction"] = status_json["art_direction"]
            except Exception:
                pass

        # Also try resume payload as another fallback
        if not manifest.get("characters"):
            resume_key = f"jobs/{run_id}/resume_payload.json"
            if s3_exists(resume_key):
                try:
                    resume_data, _ = s3_get(resume_key)
                    resume_json = json.loads(resume_data)
                    if resume_json.get("characters"):
                        manifest["characters"] = resume_json["characters"]
                    if resume_json.get("art_direction") and not manifest.get("art_direction"):
                        manifest["art_direction"] = resume_json["art_direction"]
                except Exception:
                    pass

    # If we still don't have characters but have a character sheet, extract from shot prompts
    if not manifest.get("characters") and s3_exists(char_sheet_key):
        all_chars = set()
        for shot in manifest.get("shots", []):
            for c in shot.get("characters_in_shot", []):
                all_chars.add(c)
        if all_chars:
            manifest["characters"] = {name: "(description not available — edit as needed)" for name in sorted(all_chars)}

    return respond(200, manifest)


# ── List all importable shots across runs ──
def handle_importable_shots(event):
    """Returns all shots from all runs with presigned URLs for import picker."""
    paginator = s3.get_paginator("list_objects_v2")
    run_ids = set()
    for page in paginator.paginate(Bucket=ASSETS_BUCKET, Prefix="runs/", Delimiter="/"):
        for p in page.get("CommonPrefixes", []):
            rid = p["Prefix"].replace("runs/", "").rstrip("/")
            if rid:
                run_ids.add(rid)

    all_shots = []
    for rid in sorted(run_ids, reverse=True):
        manifest_key = f"runs/{rid}/manifest.json"
        if not s3_exists(manifest_key):
            continue
        data, _ = s3_get(manifest_key)
        manifest = json.loads(data)
        for shot in manifest.get("shots", []):
            if not shot.get("image_key"):
                continue
            entry = {
                "run_id": rid,
                "run_date": manifest.get("created_at", rid),
                "index": shot.get("index", 0),
                "title": shot.get("title", ""),
                "image_prompt": shot.get("image_prompt", ""),
                "narration": shot.get("narration", ""),
                "image_key": shot.get("image_key", ""),
                "audio_key": shot.get("audio_key", ""),
            }
            if s3_exists(shot["image_key"]):
                entry["image_url"] = presigned_url(shot["image_key"])
            if shot.get("audio_key") and s3_exists(shot["audio_key"]):
                entry["audio_url"] = presigned_url(shot["audio_key"])
            all_shots.append(entry)

    return respond(200, {"shots": all_shots})


# ── Delete Run ──
def handle_delete_run(event):
    run_id = path_param(event, "run_id")
    # Delete all assets: runs (images, audio, references, manifest) AND jobs (status, resume payload)
    s3_delete_prefix(f"runs/{run_id}/")
    s3_delete_prefix(f"jobs/{run_id}/")
    logger.info(f"Deleted run and all assets: {run_id}")
    return respond(200, {"deleted": run_id})


# ── Sync / Save Storyboard with versioning ──
def handle_sync_storyboard(event):
    """Persist the full storyboard state to the manifest and snapshot a revision.

    Each save:
      - Writes the live manifest.json (current state)
      - Snapshots a numbered revision under runs/{run_id}/revisions/
      - Bumps the revision counter
    Assets are NEVER deleted on save so older revisions remain restorable.
    """
    run_id = path_param(event, "run_id")
    if not run_id:
        return respond(400, {"detail": "run_id is required"})

    body = parse_json_body(event)
    new_shots = body.get("shots", [])
    # "auto" saves (background syncs) don't create a new revision; explicit
    # user Saves do. This keeps the revision history meaningful.
    is_explicit_save = bool(body.get("create_revision", False))
    save_note = body.get("note", "")

    manifest_key = f"runs/{run_id}/manifest.json"
    manifest = {}
    old_shots = []
    if s3_exists(manifest_key):
        try:
            data, _ = s3_get(manifest_key)
            manifest = json.loads(data)
            old_shots = manifest.get("shots", [])
        except Exception:
            manifest = {}

    # Ensure base manifest fields exist (create-if-missing)
    manifest.setdefault("id", run_id)
    manifest.setdefault("created_at", now_iso())
    manifest["status"] = manifest.get("status", "storyboard")
    manifest["updated_at"] = now_iso()
    for fld in ("project_name", "project_description", "image_model", "characters",
                "characters_en", "art_direction", "music_file", "wallpaper_file",
                "music_volume", "settings", "selected_voice", "language",
                "style_key", "style_prefix"):
        if fld in body and body[fld] not in (None, ""):
            manifest[fld] = body[fld]

    # Persist full shot data (including video-shot fields)
    manifest["shots"] = [
        {
            "index": i,
            "image_key": shot.get("image_key", ""),
            "audio_key": shot.get("audio_key", ""),
            "video_key": shot.get("video_key", ""),
            "is_video": bool(shot.get("is_video")),
            "audio_mode": shot.get("audio_mode", ""),
            "title": shot.get("title", f"Shot {i + 1}"),
            "image_prompt": shot.get("image_prompt", ""),
            "narration": shot.get("narration", ""),
            "characters_in_shot": shot.get("characters_in_shot", []),
        }
        for i, shot in enumerate(new_shots)
    ]

    # Versioning: bump revision number on explicit saves
    current_rev = int(manifest.get("revision", 0))
    revision_number = current_rev
    if is_explicit_save:
        revision_number = current_rev + 1
        manifest["revision"] = revision_number
        manifest["last_saved_at"] = now_iso()

    # Write the live manifest
    s3_put(manifest_key, json.dumps(manifest).encode(), "application/json")

    revision_info = None
    if is_explicit_save:
        # Snapshot this revision
        rev_key = f"runs/{run_id}/revisions/rev-{revision_number:03d}.json"
        snapshot = dict(manifest)
        snapshot["revision"] = revision_number
        snapshot["saved_at"] = now_iso()
        snapshot["note"] = save_note
        s3_put(rev_key, json.dumps(snapshot).encode(), "application/json")

        # Maintain a lightweight revisions index
        index_key = f"runs/{run_id}/revisions/index.json"
        index = {"revisions": []}
        if s3_exists(index_key):
            try:
                idata, _ = s3_get(index_key)
                index = json.loads(idata)
            except Exception:
                index = {"revisions": []}
        index["revisions"].append({
            "revision": revision_number,
            "saved_at": snapshot["saved_at"],
            "shot_count": len(new_shots),
            "note": save_note,
            "key": rev_key,
        })
        s3_put(index_key, json.dumps(index).encode(), "application/json")
        revision_info = {"revision": revision_number, "saved_at": snapshot["saved_at"], "shot_count": len(new_shots)}
        logger.info(f"Saved storyboard for run {run_id} as revision {revision_number} ({len(new_shots)} shots)")
    else:
        logger.info(f"Auto-synced storyboard for run {run_id} ({len(new_shots)} shots, no new revision)")

    return respond(200, {
        "status": "saved",
        "shot_count": len(new_shots),
        "revision": revision_number,
        "revision_created": is_explicit_save,
        "revision_info": revision_info,
    })


# ── List Revisions ──
def handle_list_revisions(event):
    run_id = path_param(event, "run_id")
    if not run_id:
        return respond(400, {"detail": "run_id is required"})

    index_key = f"runs/{run_id}/revisions/index.json"
    if not s3_exists(index_key):
        return respond(200, {"revisions": [], "current_revision": 0})

    data, _ = s3_get(index_key)
    index = json.loads(data)

    current_rev = 0
    manifest_key = f"runs/{run_id}/manifest.json"
    if s3_exists(manifest_key):
        try:
            mdata, _ = s3_get(manifest_key)
            current_rev = int(json.loads(mdata).get("revision", 0))
        except Exception:
            pass

    revs = sorted(index.get("revisions", []), key=lambda r: r.get("revision", 0), reverse=True)
    return respond(200, {"revisions": revs, "current_revision": current_rev})


# ── Restore Revision ──
def handle_restore_revision(event):
    run_id = path_param(event, "run_id")
    if not run_id:
        return respond(400, {"detail": "run_id is required"})

    body = parse_json_body(event)
    revision_number = body.get("revision")
    if revision_number is None:
        return respond(400, {"detail": "revision is required"})

    rev_key = f"runs/{run_id}/revisions/rev-{int(revision_number):03d}.json"
    if not s3_exists(rev_key):
        return respond(404, {"detail": f"Revision {revision_number} not found"})

    rdata, _ = s3_get(rev_key)
    snapshot = json.loads(rdata)

    # Restoring creates a NEW revision on top (non-destructive history)
    manifest_key = f"runs/{run_id}/manifest.json"
    current_rev = 0
    if s3_exists(manifest_key):
        try:
            mdata, _ = s3_get(manifest_key)
            current_rev = int(json.loads(mdata).get("revision", 0))
        except Exception:
            pass

    new_rev = current_rev + 1
    restored = dict(snapshot)
    restored["revision"] = new_rev
    restored["updated_at"] = now_iso()
    restored["last_saved_at"] = now_iso()
    restored["restored_from"] = int(revision_number)
    s3_put(manifest_key, json.dumps(restored).encode(), "application/json")

    # Snapshot the restore as its own revision + index entry
    new_rev_key = f"runs/{run_id}/revisions/rev-{new_rev:03d}.json"
    snap = dict(restored)
    snap["saved_at"] = now_iso()
    snap["note"] = f"Restored from revision {revision_number}"
    s3_put(new_rev_key, json.dumps(snap).encode(), "application/json")

    index_key = f"runs/{run_id}/revisions/index.json"
    index = {"revisions": []}
    if s3_exists(index_key):
        try:
            idata, _ = s3_get(index_key)
            index = json.loads(idata)
        except Exception:
            index = {"revisions": []}
    index["revisions"].append({
        "revision": new_rev,
        "saved_at": snap["saved_at"],
        "shot_count": len(restored.get("shots", [])),
        "note": snap["note"],
        "key": new_rev_key,
    })
    s3_put(index_key, json.dumps(index).encode(), "application/json")

    logger.info(f"Restored run {run_id} from revision {revision_number} as new revision {new_rev}")

    # Return the restored manifest with presigned URLs (reuse get_manifest logic)
    return handle_get_manifest({"path": f"/api/runs/{run_id}/manifest", "pathParameters": {"run_id": run_id}})


# ── Rename Project ──
def handle_rename_project(event):
    """Update the project name (and optionally description) on a run's manifest."""
    run_id = path_param(event, "run_id")
    if not run_id:
        return respond(400, {"detail": "run_id is required"})

    body = parse_json_body(event)
    new_name = (body.get("project_name") or "").strip()
    if not new_name:
        return respond(400, {"detail": "project_name is required"})

    manifest_key = f"runs/{run_id}/manifest.json"
    if not s3_exists(manifest_key):
        return respond(404, {"detail": "Project not found"})

    data, _ = s3_get(manifest_key)
    manifest = json.loads(data)
    manifest["project_name"] = new_name
    if "project_description" in body:
        manifest["project_description"] = (body.get("project_description") or "").strip()
    manifest["updated_at"] = now_iso()
    s3_put(manifest_key, json.dumps(manifest).encode(), "application/json")

    # Keep the status.json project name in sync if present (used by some views)
    status_key = f"runs/{run_id}/status.json"
    if s3_exists(status_key):
        try:
            sdata, _ = s3_get(status_key)
            status = json.loads(sdata)
            status["project_name"] = new_name
            s3_put(status_key, json.dumps(status).encode(), "application/json")
        except Exception:
            pass

    logger.info(f"Renamed project {run_id} to '{new_name}'")
    return respond(200, {"status": "renamed", "run_id": run_id, "project_name": new_name})


# ── Save As (clone a run into a brand-new project) ──
def handle_save_as_project(event):
    """Clone a run's manifest and all of its S3 assets into a new run_id."""
    run_id = path_param(event, "run_id")
    if not run_id:
        return respond(400, {"detail": "run_id is required"})

    body = parse_json_body(event)
    new_name = (body.get("project_name") or "").strip()

    src_manifest_key = f"runs/{run_id}/manifest.json"
    if not s3_exists(src_manifest_key):
        return respond(404, {"detail": "Source project not found"})

    # New run id (timestamp-based, matches the process-script convention)
    new_run_id = datetime.now(timezone.utc).strftime("%Y-%m-%d_%H%M%S") + "-copy"

    # Copy every object under runs/{run_id}/ to runs/{new_run_id}/, remapping keys.
    # Skip the revisions history — the copy starts its own fresh history.
    src_prefix = f"runs/{run_id}/"
    dst_prefix = f"runs/{new_run_id}/"
    key_map = {}
    copied = 0
    for obj in s3_list(src_prefix):
        src_key = obj["Key"]
        rel = src_key[len(src_prefix):]
        if rel.startswith("revisions/") or rel == "manifest.json" or rel == "status.json":
            continue
        dst_key = dst_prefix + rel
        try:
            s3.copy_object(
                Bucket=ASSETS_BUCKET,
                CopySource={"Bucket": ASSETS_BUCKET, "Key": src_key},
                Key=dst_key,
            )
            key_map[src_key] = dst_key
            copied += 1
        except Exception as e:
            logger.warning(f"Save As: failed to copy {src_key}: {e}")

    # Build the new manifest with remapped asset keys
    data, _ = s3_get(src_manifest_key)
    manifest = json.loads(data)
    manifest["id"] = new_run_id
    manifest["created_at"] = now_iso()
    manifest["updated_at"] = now_iso()
    manifest["status"] = "storyboard"
    manifest["revision"] = 0
    manifest.pop("video_key", None)  # the assembled video is not copied
    manifest.pop("restored_from", None)
    if new_name:
        manifest["project_name"] = new_name
    else:
        manifest["project_name"] = (manifest.get("project_name", "") or "Untitled") + " (Copy)"

    def remap(k):
        return key_map.get(k, "")

    for shot in manifest.get("shots", []):
        if shot.get("image_key"):
            shot["image_key"] = remap(shot["image_key"]) or shot["image_key"]
        if shot.get("audio_key"):
            shot["audio_key"] = remap(shot["audio_key"]) or shot["audio_key"]
        # video_key may live outside the run prefix (uploaded videos) — keep as-is if not remapped
        if shot.get("video_key"):
            shot["video_key"] = remap(shot["video_key"]) or shot["video_key"]

    s3_put(f"runs/{new_run_id}/manifest.json", json.dumps(manifest).encode(), "application/json")
    logger.info(f"Save As: cloned {run_id} -> {new_run_id} ('{manifest['project_name']}', {copied} assets copied)")

    return respond(200, {
        "status": "copied",
        "run_id": new_run_id,
        "project_name": manifest["project_name"],
        "assets_copied": copied,
    })


# ── Run Image ──
def handle_run_image(event):
    run_id = path_param(event, "run_id")
    filename = path_param(event, "filename")
    key = f"runs/{run_id}/images/{filename}"
    if not s3_exists(key):
        return respond(404, {"detail": "Not found"})
    data, ct = s3_get(key)
    return {
        "statusCode": 200,
        "headers": {"Content-Type": ct or "image/jpeg", "Access-Control-Allow-Origin": "*"},
        "body": base64.b64encode(data).decode(),
        "isBase64Encoded": True,
    }


# ── Demo Data ──
def handle_demo_data(event):
    return respond(200, {"shots": [], "message": "No demo data configured"})


# ── Transcribe Video (extract audio and transcribe using Amazon Transcribe) ──
def handle_transcribe_video(event):
    """Start async transcription of a video using Amazon Transcribe.

    The spoken language of the uploaded video is independent of the project language.
    An English-voiced clip can be dropped into a French project, or the reverse, so the
    caller sends `source_language` for what is actually spoken in the video. Only when
    that is absent does the project language act as the fallback.

    Returns a job_name to poll.
    """
    body = parse_json_body(event)
    video_key = body.get("video_key", "")

    if not video_key:
        return respond(400, {"detail": "video_key is required"})

    if not s3_exists(video_key):
        return respond(404, {"detail": "Video not found in S3"})

    # Transcribing with the wrong locale yields unusable text, so this must reflect
    # what is spoken in the video, not what the project is authored in.
    language = normalize_language(
        body.get("source_language")
        or body.get("language")
        or get_run_language(body.get("run_id", ""))
    )

    try:
        import time

        transcribe_client = boto3.client("transcribe", region_name="us-east-1")
        job_name = f"{SERVICE_NAME}-transcribe-{int(time.time())}-{uuid.uuid4().hex[:8]}"
        media_uri = f"s3://{ASSETS_BUCKET}/{video_key}"

        # Determine media format
        if video_key.endswith(".webm"):
            media_format = "webm"
        elif video_key.endswith(".mov"):
            media_format = "mp4"
        else:
            media_format = "mp4"

        # Start transcription job (async — returns immediately)
        transcribe_client.start_transcription_job(
            TranscriptionJobName=job_name,
            Media={"MediaFileUri": media_uri},
            MediaFormat=media_format,
            LanguageCode=TRANSCRIBE_LANGUAGE_CODES[language],
            OutputBucketName=ASSETS_BUCKET,
            OutputKey=f"transcriptions/{job_name}.json",
        )

        logger.info(
            f"Started transcription job {job_name} for {video_key} "
            f"in {TRANSCRIBE_LANGUAGE_CODES[language]}"
        )
        return respond(200, {
            "job_name": job_name,
            "status": "IN_PROGRESS",
            "source_language": language,
        })

    except Exception as e:
        logger.exception(f"Failed to start transcription: {e}")
        return respond(500, {"detail": f"Failed to start transcription: {str(e)}"})


def handle_transcribe_status(event):
    """Poll transcription job status. Returns transcript when complete."""
    body = parse_json_body(event)
    job_name = body.get("job_name", "")

    if not job_name:
        return respond(400, {"detail": "job_name is required"})

    try:
        transcribe_client = boto3.client("transcribe", region_name="us-east-1")
        status_resp = transcribe_client.get_transcription_job(TranscriptionJobName=job_name)
        status = status_resp["TranscriptionJob"]["TranscriptionJobStatus"]

        if status == "IN_PROGRESS":
            return respond(200, {"status": "IN_PROGRESS", "job_name": job_name})

        elif status == "COMPLETED":
            # Read the transcript from S3
            transcript_key = f"transcriptions/{job_name}.json"
            if s3_exists(transcript_key):
                transcript_data, _ = s3_get(transcript_key)
                transcript_json = json.loads(transcript_data)
                transcription = transcript_json.get("results", {}).get("transcripts", [{}])[0].get("transcript", "")
                logger.info(f"Transcription complete: {job_name} ({len(transcription)} chars)")

                # Clean up
                try:
                    s3.delete_object(Bucket=ASSETS_BUCKET, Key=transcript_key)
                    transcribe_client.delete_transcription_job(TranscriptionJobName=job_name)
                except Exception:
                    pass

                return respond(200, {"status": "COMPLETED", "transcription": transcription})
            else:
                return respond(500, {"detail": "Transcription completed but output not found"})

        elif status == "FAILED":
            reason = status_resp["TranscriptionJob"].get("FailureReason", "Unknown")
            logger.error(f"Transcription failed: {job_name} — {reason}")
            try:
                transcribe_client.delete_transcription_job(TranscriptionJobName=job_name)
            except Exception:
                pass
            return respond(200, {"status": "FAILED", "detail": reason})

        else:
            return respond(200, {"status": status, "job_name": job_name})

    except Exception as e:
        logger.exception(f"Transcription status check failed: {e}")
        return respond(500, {"detail": f"Status check failed: {str(e)}"})


# ── Refine Narration (translate and/or polish for re-voicing uploaded video) ──

# The polished text is dubbed over footage of fixed duration, so length is a hard
# constraint, not a preference. The model is asked to stay within ±10%; anything beyond
# the outer bound is rejected in favour of the original, because narration that no longer
# fits the picture is worse than narration that reads a little roughly.
REFINE_TARGET_TOLERANCE = 0.10
REFINE_REJECT_TOLERANCE = 0.25


def handle_refine_narration(event):
    """Translate and/or polish voice-over narration, preserving spoken length.

    Serves two needs for uploaded video, in a single model call so the two never fight
    each other:

      Translation — the clip is voiced in one language and the project needs the other.
      Polish      — raw transcripts of spontaneous speech carry filler, false starts and
                    repetition. Cleaning them up makes the re-voiced narration sound
                    professional.

    Doing both at once matters: translating first and polishing after tends to produce
    stilted output, because the polish pass inherits translation artefacts.

    Length is guarded rather than merely requested. The result is dubbed over footage of
    a fixed duration, so a refinement that runs materially longer or shorter is rejected
    and the original returned.
    """
    body = parse_json_body(event)
    text = (body.get("text") or "").strip()
    source_language = normalize_language(body.get("source_language"))
    target_language = normalize_language(body.get("target_language"))
    # Default on: a raw transcript almost always reads better for a small cost.
    polish = body.get("polish", True) is not False

    if not text:
        return respond(400, {"detail": "text is required"})

    needs_translation = source_language != target_language
    if not needs_translation and not polish:
        # Nothing asked for. Answering successfully keeps the caller simple.
        return respond(200, {
            "text": text,
            "translated": False,
            "polished": False,
            "source_language": source_language,
            "target_language": target_language,
            "original_words": len(text.split()),
            "refined_words": len(text.split()),
        })

    source_name = LANGUAGE_NAMES[source_language]
    target_name = LANGUAGE_NAMES[target_language]
    original_words = len(text.split())
    lower_words = int(original_words * (1 - REFINE_TARGET_TOLERANCE))
    upper_words = int(original_words * (1 + REFINE_TARGET_TOLERANCE))

    tasks = []
    if needs_translation:
        tasks.append(f"translate it from {source_name} to {target_name}")
    if polish:
        tasks.append("polish it so it reads as fluent, professional voice-over")

    system = (
        f"You prepare voice-over narration for video. Your job is to {' and '.join(tasks)}.\n\n"
        "LENGTH IS A HARD CONSTRAINT:\n"
        f"- The source is {original_words} words. Your output MUST be between "
        f"{lower_words} and {upper_words} words.\n"
        "- This narration is spoken over existing footage of fixed length. Running long "
        "or short breaks synchronisation with the picture.\n"
        "- Do not summarise, and do not pad. Rephrase at the same length.\n\n"
        "WHAT TO IMPROVE:\n"
        "- Remove filler and hesitation: um, uh, you know, like, I mean, sort of.\n"
        "- Remove false starts, self-corrections, and accidental repetition.\n"
        "- Join fragments into complete, well-formed sentences.\n"
        "- Fix grammar and word order from transcription of spontaneous speech.\n"
        "- Smooth transitions between sentences so it flows when read aloud.\n"
        "- Use a confident, professional register suited to a marketing voice-over.\n\n"
        "WHAT TO PRESERVE:\n"
        "- Every fact, figure, name, and claim. Add nothing that is not in the source.\n"
        "- The order in which points are made, so the narration still matches the visuals.\n"
        "- Proper nouns, brand names, and place names, exactly as given.\n"
        "- The speaker's intent and emphasis.\n\n"
        "OUTPUT:\n"
        "- Return ONLY the finished narration. No preamble, no quotes, no notes, no "
        "explanation of what you changed.\n"
        "- Write numbers and abbreviations the way they should be spoken aloud."
    )
    if target_language == "fr":
        system += (
            "\n- Write natural, idiomatic French using French typographic convention: a "
            "space before : ; ! and ?, and guillemets for quotations."
        )

    try:
        refined = call_claude(system, text, max_tokens=6000).strip().strip('"').strip("'")
    except ClientError as e:
        logger.exception(f"Narration refinement failed {source_language} -> {target_language}")
        return respond(500, {"detail": str(e)})

    if not refined:
        logger.warning("Narration refinement returned empty text; keeping the original")
        return respond(200, {
            "text": text,
            "translated": False,
            "polished": False,
            "source_language": source_language,
            "target_language": target_language,
            "original_words": original_words,
            "refined_words": original_words,
            "detail": "Refinement returned no text",
        })

    refined_words = len(refined.split())
    drift = abs(refined_words - original_words) / max(1, original_words)

    if drift > REFINE_REJECT_TOLERANCE:
        # Reject rather than hand back narration that will not fit the footage. The
        # transcript is still usable as-is, so nothing is lost.
        logger.warning(
            f"Narration refinement changed length by {drift*100:.0f}% "
            f"({original_words} -> {refined_words} words), beyond the "
            f"{REFINE_REJECT_TOLERANCE*100:.0f}% limit; keeping the original"
        )
        return respond(200, {
            "text": text,
            "translated": False,
            "polished": False,
            "source_language": source_language,
            "target_language": target_language,
            "original_words": original_words,
            "refined_words": refined_words,
            "detail": (
                f"The refined narration was {refined_words} words against {original_words} "
                "in the original, which would not fit the video. The original was kept."
            ),
        })

    logger.info(
        f"Refined narration {source_language} -> {target_language} "
        f"(translate={needs_translation} polish={polish}): "
        f"{original_words} -> {refined_words} words ({drift*100:.0f}% drift)"
    )
    return respond(200, {
        "text": refined,
        "original_text": text,
        "translated": needs_translation,
        "polished": polish,
        "source_language": source_language,
        "target_language": target_language,
        "original_words": original_words,
        "refined_words": refined_words,
    })


# ── Preview Merge (merge video + audio into a preview clip) ──
def handle_preview_merge(event):
    """Start async merge of video + audio for preview. Uses the merge Lambda."""
    body = parse_json_body(event)
    video_key = body.get("video_key", "")
    audio_key = body.get("audio_key", "")
    audio_mode = body.get("audio_mode", "native")

    if not video_key:
        return respond(400, {"detail": "video_key is required"})

    if not s3_exists(video_key):
        return respond(404, {"detail": "Video not found in S3"})

    # For non-native audio, we need an audio key
    if audio_mode != "native" and not audio_key:
        return respond(400, {"detail": "audio_key is required for non-native audio mode"})

    preview_id = f"preview-{uuid.uuid4().hex[:8]}"
    status_key = f"runs/{preview_id}/status.json"

    # Write initial status
    s3_put(status_key, json.dumps({
        "run_id": preview_id, "status": "processing",
        "detail": "Merging video and audio…", "progress": 10,
    }).encode(), "application/json")

    # Invoke merge Lambda with a single clip
    merge_payload = {
        "run_id": preview_id,
        "clips": [{"video_key": video_key, "audio_key": audio_key if audio_mode != "native" else ""}],
        "music_key": "",
        "wallpaper_key": "",
        "shot_duration": 6,
    }

    try:
        lambda_client.invoke(
            FunctionName=MERGE_FUNCTION_NAME,
            InvocationType="Event",
            Payload=json.dumps(merge_payload).encode(),
        )
        logger.info(f"Preview merge started: {preview_id}")
        return respond(200, {"preview_id": preview_id, "status": "processing"})
    except Exception as e:
        logger.exception("Failed to invoke merge Lambda for preview")
        return respond(500, {"detail": str(e)})


def handle_preview_merge_status(event):
    """Poll preview merge status."""
    body = parse_json_body(event)
    preview_id = body.get("preview_id", "")

    if not preview_id:
        return respond(400, {"detail": "preview_id is required"})

    status_key = f"runs/{preview_id}/status.json"
    if not s3_exists(status_key):
        return respond(404, {"detail": "Preview job not found"})

    data, _ = s3_get(status_key)
    status_data = json.loads(data)

    # Check if the final video exists
    output_key = f"runs/{preview_id}/output/final.mp4"
    if status_data.get("status") == "complete" or s3_exists(output_key):
        url = presigned_url(output_key, expires=3600)
        # Clean up preview files after generating URL
        return respond(200, {"status": "complete", "preview_url": url})

    return respond(200, status_data)


# ── Presign Key (generate presigned URL for any S3 key) ──
def handle_presign_key(event):
    """Generate a presigned URL for a given S3 key."""
    body = parse_json_body(event)
    key = body.get("key", "")

    if not key:
        return respond(400, {"detail": "key is required"})

    if not s3_exists(key):
        return respond(404, {"detail": "Object not found"})

    return respond(200, {"url": presigned_url(key)})


# ═══════════════════════════════════════════════════════════════
# ROUTER
# ═══════════════════════════════════════════════════════════════

ROUTES = {
    ("GET",  "/health"):                                    handle_health,
    ("POST", "/api/extract-text"):                          handle_extract_text,
    ("POST", "/api/process-script"):                        handle_process_script,
    ("POST", "/api/approve-characters/{job_id}"):            handle_approve_characters,
    ("POST", "/api/regenerate-character-sheet"):             handle_regenerate_character_sheet,
    ("GET",  "/api/script-status/{job_id}"):                handle_script_status,
    ("POST", "/api/generate-image"):                        handle_generate_image,
    ("POST", "/api/generate-audio"):                        handle_generate_audio,
    ("POST", "/api/audio-status"):                          handle_audio_status,
    ("POST", "/api/ai-help"):                               handle_ai_help,
    ("POST", "/api/ai-help-narration"):                     handle_ai_help_narration,
    ("GET",  "/api/voices"):                                handle_voices,
    ("POST", "/api/voice-sample/{voice_id}"):               handle_voice_sample,
    ("GET",  "/api/play-voice-sample/{voice_id}"):          handle_play_voice_sample,
    ("GET",  "/api/music-tracks"):                          handle_music_tracks,
    ("POST", "/api/upload-music"):                          handle_upload_music,
    ("POST", "/api/delete-music"):                          handle_delete_music,
    ("GET",  "/api/preview-music/{filename}"):              handle_preview_music,
    ("GET",  "/api/wallpapers"):                            handle_wallpapers,
    ("POST", "/api/upload-wallpaper"):                      handle_upload_wallpaper,
    ("POST", "/api/delete-wallpaper"):                      handle_delete_wallpaper,
    ("GET",  "/api/preview-wallpaper/{source}/{filename}"): handle_preview_wallpaper,
    ("POST", "/api/create-video"):                          handle_create_video,
    ("GET",  "/api/video-status/{job_id}"):                 handle_video_status,
    ("GET",  "/api/download-video/{job_id}"):               handle_download_video,
    ("GET",  "/api/preview-video/{job_id}"):                handle_preview_video,
    ("GET",  "/api/runs"):                                  handle_runs,
    ("GET",  "/api/runs/importable-shots"):                  handle_importable_shots,
    ("GET",  "/api/runs/{run_id}/manifest"):                 handle_get_manifest,
    ("POST", "/api/runs/{run_id}/sync-storyboard"):          handle_sync_storyboard,
    ("GET",  "/api/runs/{run_id}/revisions"):                handle_list_revisions,
    ("POST", "/api/runs/{run_id}/restore-revision"):         handle_restore_revision,
    ("POST", "/api/runs/{run_id}/rename"):                   handle_rename_project,
    ("POST", "/api/runs/{run_id}/save-as"):                  handle_save_as_project,
    ("POST", "/api/transcribe-video"):                       handle_transcribe_video,
    ("POST", "/api/transcribe-status"):                      handle_transcribe_status,
    # Both names route to the same handler. /api/refine-narration is the current name;
    # /api/translate-narration is kept so a browser holding a cached app.js from the
    # previous deploy keeps working rather than failing mid-session.
    ("POST", "/api/refine-narration"):                       handle_refine_narration,
    ("POST", "/api/translate-narration"):                    handle_refine_narration,
    ("POST", "/api/preview-merge"):                          handle_preview_merge,
    ("POST", "/api/preview-merge-status"):                   handle_preview_merge_status,
    ("POST", "/api/presign-key"):                            handle_presign_key,
    ("DELETE", "/api/runs/{run_id}"):                       handle_delete_run,
    ("GET",  "/api/run-image/{run_id}/{filename}"):         handle_run_image,
    ("GET",  "/api/demo-data"):                             handle_demo_data,
    ("POST", "/api/analyze-style-image"):                   handle_analyze_style,
}


def match_route(method, path):
    for (route_method, route_pattern), handler_fn in ROUTES.items():
        if method != route_method:
            continue
        regex = re.sub(r"\{(\w+)\}", r"(?P<\1>[^/]+)", route_pattern)
        if re.fullmatch(regex, path):
            return handler_fn
    return None


def handler(event, context):
    # Handle async task invocations (self-invoked via Lambda Event)
    if "_async_task" in event:
        task = event["_async_task"]
        logger.info(f"Async task: {task}")
        if task == "process_script":
            _async_process_script(event)
            return {"statusCode": 200}
        if task == "generate_audio":
            _async_generate_audio(event)
            return {"statusCode": 200}
        return {"statusCode": 400, "body": f"Unknown task: {task}"}

    method = event.get("httpMethod", "GET")
    path = event.get("path", "/")

    logger.info(f"Request: {method} {path}")

    if method == "OPTIONS":
        return respond(200, {"message": "ok"})

    handler_fn = match_route(method, path)
    if not handler_fn:
        stripped = re.sub(r"^/prod", "", path)
        handler_fn = match_route(method, stripped)

    if not handler_fn:
        return respond(404, {"error": "Not found", "path": path, "method": method})

    try:
        return handler_fn(event)
    except Exception as e:
        logger.exception(f"Unhandled error on {method} {path}")
        return respond(500, {"error": "Internal server error", "detail": str(e)})
