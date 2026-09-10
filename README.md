# Video AI Orchestrator (VAIO)

Turn a written script into a narrated marketing video. VAIO extracts characters from
the script, locks their visual design so they stay consistent shot to shot, generates
storyboard images, synthesizes narration, and assembles the final video.

Fully bilingual: author a project in **English or French**. Both a light and a dark
theme are available.

Rebranded and extended from `destination-ontario-marketing-video`.

## What it does

1. **Upload a script** — paste text, or drop a `.txt`, `.md`, or `.docx` file.
2. **Pick a language** — English or French. This fixes the language of the narration,
   shot titles, and character descriptions for the life of the project.
3. **Review characters** — Claude extracts every person and personified entity and
   writes a locked visual design for each. Edit the descriptions, regenerate the
   character reference sheet, then approve.
4. **Edit the storyboard** — per shot, adjust the image prompt and narration, ask the
   AI assistant to refine either, regenerate, import a shot from a previous project,
   upload a local image, or drop in an existing video clip.
5. **Finalize** — add background music and wallpaper bookends, then assemble.

Storyboards are versioned: every explicit save snapshots a numbered revision, and
restoring an older revision creates a new one rather than overwriting history.

## Bilingual behaviour

One choice, three separate consequences — kept deliberately distinct:

| Concern | English project | French project |
| --- | --- | --- |
| Narration, shot titles, character descriptions | English | French |
| Image prompts sent to the image model | English | **English** (translated) |
| Nova Sonic narration voices | Tiffany, Matthew, Amy | Ambre, Florian, plus the polyglot Tiffany and Matthew |
| Polly fallback voice | Tiffany / Matthew / Joanna | Gabrielle / Liam (`fr-CA`) |
| Amazon Transcribe locale | `en-US` | `fr-CA` |

Image prompts are always English on purpose. The image models follow English prompts
markedly more reliably, so a French project has its prompts translated by Claude before
dispatch. Structure, ordering, and the style prefix are preserved verbatim during
translation, because shot-to-shot visual consistency depends on the prefix being
byte-identical across every shot.

Two enforcement layers back this up: the shot-generation system prompt asks for English
image prompts, and a post-processing pass in `_async_process_script` detects and
translates any prompt that still came back in French. The instruction alone is not
reliable enough when every other field is French.

Character descriptions are stored twice — `characters` in the project language for the
user to read and edit, `characters_en` in English for prompting.

The **interface** language is separate from the **project** language. It is stored per
browser and can be switched at any time without touching project data. Picking a
project language also switches the interface to match, since that is nearly always what
is wanted.

## Theming

`theme.js` writes `data-theme="light|dark"` on `<html>` before first paint. Every colour
in `styles.css` is a custom property scoped to that attribute, so switching is a single
attribute write with no reflow and no flash.

Three settings: **Light**, **Dark**, and **System**. System follows the OS preference and
keeps following it if the OS changes while the console is open. The choice persists in
`localStorage`.

Palettes are chosen so body text meets the WCAG AA 4.5:1 contrast ratio against the
surface it sits on in both themes. Accent colours are darkened in the light theme, since
the dark-theme values are too light to read on white.

Adding a colour means declaring it in **both** theme blocks. `scripts/` validation
rejects colour literals in rules and any token missing from one theme.

## Architecture

```
Browser (CloudFront + S3)
   |
   |  Cognito ID token
   v
API Gateway  ──►  API Lambda (python3.12)
                    ├── Bedrock: Claude Opus 5 / Sonnet 5   (storyboards, narration, translation)
                    ├── Bedrock: Nova Sonic                 (narration audio)
                    ├── Bedrock: Nova Canvas / SD3.5        (images)
                    ├── Gemini API (Nano Banana Pro)        (images, default)
                    ├── SageMaker: SDXL + IP-Adapter        (character-consistent images)
                    ├── Amazon Polly                        (audio fallback)
                    ├── Amazon Transcribe                   (re-voicing uploaded video)
                    └── async self-invoke                   (work beyond the 29s API limit)
                          |
                          v
                  Merge Lambda (10 GB, ffmpeg + moviepy)  ──►  S3 assets bucket
```

Two models are used deliberately: **Opus 5** for the creative, language-sensitive
generation, and **Sonnet 5** for the short mechanical calls (prompt translation, style
condensation) where its lower latency and cost matter and quality is not the constraint.

Long-running work is handed off by invoking the API Lambda asynchronously, keeping every
request inside API Gateway's 29-second response limit. The browser polls for status.

### Repository layout

```
cdk/
  bin/app.ts               CDK app entry; account and region overridable via context
  lib/vaio-stack.ts        The whole stack
  lambda/api/handler.py    API handler — routes, generation pipeline, language layer
  lambda/api/requirements.txt   Fully pinned, including transitive dependencies
  lambda/merge/handler.py   ffmpeg assembly (no language or branding coupling)
web-ui/
  index.html               Markup, declarative i18n attributes, Cognito auth
  app.js                   Application logic
  i18n.js                  EN + FR dictionary and translation engine
  theme.js                 Theme resolution and persistence
  styles.css               Theme-scoped design tokens
scripts/                   Build, bootstrap, and deploy
```

`web-ui/` is the single source of truth. `web-ui-dist/` is generated and gitignored —
never edit it directly. (In the predecessor project the built output had drifted ahead of
the source, which is the trap this layout avoids.)

## Prerequisites

- AWS credentials for the target account, with Bedrock model access enabled in
  `us-east-1` for Claude Opus 5, Claude Sonnet 5, Nova Sonic, and Nova Canvas
- Node.js 20+ and Python 3.12
- A Gemini API key, if you want the default Advanced image model

`us-east-1` is required rather than merely conventional: Nova Sonic bidirectional
streaming, Nova Canvas, and the `us.anthropic.*` Claude inference profiles are not all
available in `ca-central-1`.

## Deploy

```powershell
# One time: create the Lambda code bucket and store the Gemini key as a
# SecureString in SSM Parameter Store.
.\scripts\bootstrap-resources.ps1 -GeminiApiKey '<your-key>'

# Build both bundles, deploy the stack, publish the frontend.
.\scripts\deploy.ps1
```

`deploy.ps1` runs in phases because the frontend needs values that only exist after the
stack is created: it builds, deploys, then regenerates `config.js` from the stack outputs
and re-uploads the frontend.

Useful flags:

```powershell
.\scripts\deploy.ps1 -SkipDeps          # reuse installed Lambda dependencies
.\scripts\build-api-lambda.ps1          # rebuild only the API bundle
.\scripts\build-frontend.ps1            # regenerate config.js and the frontend bundle
```

Dependencies must be installed with manylinux platform flags so the native wheels
(`awscrt`, `ijson`) match the Lambda runtime instead of the build machine.
`build-api-lambda.ps1` does this and fails loudly if Windows `.pyd` files appear or no
Linux `.so` files do.

## Configuration

| Setting | Where | Notes |
| --- | --- | --- |
| Gemini API key | SSM SecureString `/vaio/gemini-api-key` | Read at Lambda cold start and cached. Never in an environment variable or in git. |
| Claude models | `CLAUDE_MODEL_ID`, `CLAUDE_FAST_MODEL_ID` | Default to Opus 5 and Sonnet 5. |
| Default language | `DEFAULT_LANGUAGE` | Fallback when a request or manifest has none. |
| API URL, Cognito IDs | `web-ui/config.js` | Generated from stack outputs; gitignored. |

Nothing environment-specific is committed. `config.js` is written at build time from
CloudFormation outputs.

## Security notes

- All `/api/*` routes require a Cognito ID token. `/health` is intentionally open so
  deployments can be smoke tested; it returns only service name, status, and timestamp.
- The Gemini key lives in SSM Parameter Store as a SecureString. The predecessor project
  had it hardcoded in the CDK source.
- CloudFront is geo-restricted to Canada.
- Both S3 buckets block all public access, enforce TLS, and are encrypted at rest.
- Buckets use `RemovalPolicy.DESTROY` with `autoDeleteObjects` — appropriate for a dev
  stack, but it means `cdk destroy` deletes generated media. Switch to `RETAIN` before
  treating any of this as production.

## Known gaps

- `SAGEMAKER_ENDPOINT` still defaults to `rit-sdxl-ip-adapter`, the endpoint name that
  exists in the account. The SDXL + IP-Adapter image model only works where that
  endpoint is deployed; the other two image models have no such dependency.
- The reference-image style transfer and the SDXL path were carried over unchanged and
  have not been re-verified end to end under this rebrand.
