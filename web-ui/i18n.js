/**
 * Video AI Orchestrator (VAIO) — internationalization
 *
 * Two languages, one dictionary. Every user-visible string in the console lives
 * here; nothing is hardcoded in markup or logic.
 *
 * Two distinct concepts are deliberately kept apart:
 *
 *   Interface language (`uiLang`) — what the console chrome is written in. Persisted
 *   per browser and switchable at any time without touching project data.
 *
 *   Project language (`state.language`) — the language a storyboard's narration and
 *   titles are generated in. Chosen once when the project is created, stored on the
 *   manifest, and never silently changed, because altering it would invalidate the
 *   generated narration and voices.
 *
 * Selecting a project language also switches the interface to match, since that is
 * what a user almost always wants. Switching the interface afterwards does not touch
 * the project.
 *
 * Markup is translated declaratively:
 *   data-i18n="key"              -> element textContent
 *   data-i18n-html="key"         -> element innerHTML (for strings containing markup)
 *   data-i18n-placeholder="key"  -> placeholder attribute
 *   data-i18n-title="key"        -> title attribute
 *   data-i18n-aria-label="key"   -> aria-label attribute
 */

// Wrapped in an IIFE so nothing leaks to the global scope. This file loads as a
// classic script, where a top-level `function t()` would become a global binding and
// collide with app.js destructuring `const { t } = window.VaioI18n` — a collision that
// makes the whole of app.js fail to parse, taking every event listener with it.
// The only intended export is window.VaioI18n, assigned at the bottom.
//
// The body is deliberately left unindented to keep this wrapper reviewable as a
// two-line change rather than a whole-file reformat.
(function () {
'use strict';

const I18N_STRINGS = {
  en: {
    // ── App shell ──
    'app.name': 'Video AI Orchestrator',
    'app.shortName': 'VAIO',
    'app.tagline': 'Storyboard to video, in English or French',

    // ── Auth ──
    'auth.signInPrompt': 'Sign in to continue',
    'auth.email': 'Email',
    'auth.password': 'Password',
    'auth.signIn': 'Sign In',
    'auth.noAccount': 'No account?',
    'auth.signUp': 'Sign up',
    'auth.signOut': 'Sign Out',
    'auth.inviteOnly': 'Accounts are created by an administrator. Contact your administrator to request access.',
    'auth.signUpDisabled': 'Self-registration is disabled for this environment.',
    'auth.newPasswordRequired': 'A new password is required.',
    'auth.newPassword': 'New Password',
    'auth.setPassword': 'Set Password',
    'auth.checkEmail': 'Check your email for a verification code.',
    'auth.verificationCode': 'Verification Code',
    'auth.confirm': 'Confirm',
    'auth.confirmed': 'Confirmed. You can sign in now.',
    'auth.signInFailed': 'Sign in failed',
    'auth.failed': 'Failed',

    // ── Top bar ──
    'nav.previousRuns': 'Previous Runs',
    'nav.language': 'Language',
    'nav.theme': 'Theme',
    'nav.themeLight': 'Light',
    'nav.themeDark': 'Dark',
    'nav.themeSystem': 'System',
    'nav.switchToLight': 'Switch to light theme',
    'nav.switchToDark': 'Switch to dark theme',

    // ── Status badge ──
    'status.ready': 'Ready',
    'status.processing': 'Processing…',
    'status.analyzingStyle': 'Analyzing style…',
    'status.styleExtracted': 'Style extracted',
    'status.styleFailed': 'Style analysis failed',
    'status.readingDocument': 'Reading document…',
    'status.documentLoaded': 'Document loaded',
    'status.uploadFailed': 'Upload failed',
    'status.processingFailed': 'Processing failed',
    'status.generatingAssets': 'Generating assets…',
    'status.allAssetsReady': 'All assets ready',
    'status.creating': 'Creating…',
    'status.videoCreated': 'Video created',
    'status.assemblyFailed': 'Assembly failed',
    'status.lostConnection': 'Lost connection',
    'status.failed': 'Failed',
    'status.renaming': 'Renaming…',
    'status.projectRenamed': 'Project renamed',
    'status.renameFailed': 'Rename failed',
    'status.saveFailed': 'Save failed — please try again',
    'status.saveAsFailed': 'Save As failed',
    'status.restoreFailed': 'Restore failed',
    'status.promptUpdated': 'Prompt updated',
    'status.narrationUpdated': 'Narration updated',
    'status.aiHelpFailed': 'AI assistant failed',
    'status.videoShotAdded': 'Video shot added',
    'status.loadingShots': 'Loading shots from previous runs…',
    'status.loadShotsFailed': 'Could not load shots',

    // ── Project panel ──
    'project.heading': 'Project',
    'project.namePlaceholder': 'Project name (e.g., Summer Tourism Campaign)',
    'project.descriptionPlaceholder': 'Brief description (optional)',
    'project.untitled': 'Untitled Project',
    'project.editName': 'Edit project name',

    // ── Language picker ──
    'language.heading': 'Project Language',
    'language.help':
      'Choose the language your script is written in. Narration, shot titles, and character descriptions are generated in this language. Image prompts are always produced in English, because image models follow English far more reliably.',
    'language.english': 'English',
    'language.french': 'French',
    'language.englishDesc': 'Generate narration and titles in English',
    'language.frenchDesc': 'Generate narration and titles in French',
    'language.lockedNotice': 'Set when the project was created. Create a new project to change it.',

    // ── Upload ──
    'upload.heading': 'Upload Your Script',
    'upload.help': 'Drag and drop a .txt, .md, or .docx file, or click to browse',
    'upload.browse': 'Browse Files',
    'upload.supports': 'Supports .txt, .md, .docx',
    'upload.or': 'or',
    'upload.pastePlaceholder': 'Paste your marketing script here…',
    'upload.unsupportedType': 'Unsupported file type: .{ext}',
    'upload.readFailed': 'Could not read the document: {error}',

    // ── Style picker ──
    'style.heading': 'Visual Style',
    'style.pastelCartoon': 'Pastel Cartoon',
    'style.pastelCartoonDesc': 'Soft pastel colours, clean outlines, flat 2D cartoon style',
    'style.boldCorporate': 'Bold Corporate',
    'style.boldCorporateDesc': 'High-energy gradients, confident geometric shapes, premium feel',
    'style.customImage': 'Custom Reference Image',
    'style.customImageDesc': 'Upload an image and AI will extract the visual style',
    'style.upload': 'Upload',
    'style.extracted': 'Extracted Style',
    'style.analyzeFailed': 'Could not analyze the image: {error}',

    // ── Image model picker ──
    'model.heading': 'Image Model',
    'model.standard': 'Standard',
    'model.standardTag': '(Legacy)',
    'model.standardDesc': 'Amazon Nova Canvas — fast and reliable, good prompt adherence',
    'model.advanced': 'Advanced',
    'model.advancedDesc': 'High-quality creative image generation — best for complex scenes',
    'model.experimental': 'SDXL + IP-Adapter',
    'model.experimentalTag': '(Experimental)',
    'model.experimentalDesc': 'Character-consistent generation via identity-preserving references',
    'model.badgeAdvanced': 'Advanced',
    'model.badgeStandard': 'Standard (Legacy)',
    'model.badgeExperimental': 'SDXL + IP-Adapter (Experimental)',
    'model.fallbackNotice': '{selected} failed, used {used}',

    // ── Settings ──
    'settings.heading': 'Settings',
    'settings.shotCount': 'Shot Count',
    'settings.shotDuration': 'Shot Duration',
    'settings.totalDuration': 'Total Duration',

    // ── Narrative style ──
    'narrative.heading': 'Narrative Style',
    'narrative.default':
      'Create a high-energy marketing video focused on the end-user experience for an end-user audience.',

    // ── Reference images ──
    'refs.heading': 'Reference Images',
    'refs.optional': '(optional)',
    'refs.help':
      'Upload logos, scenery, products, or other visual references. These are labelled and passed to the image model for consistency.',
    'refs.add': 'Add Reference Image',
    'refs.labelPlaceholder': 'Label this image…',

    // ── Voice ──
    'voice.heading': 'Voice',
    'voice.loading': 'Loading voices…',
    'voice.loadFailed': 'Could not load voices',
    'voice.sample': 'Sample',
    'voice.playing': 'Playing',
    'voice.sampleFailed': 'Failed',
    'voice.narrationVoice': 'Narration voice',
    'voice.setTo': 'Narration voice set to {name}',

    // ── Process button ──
    'process.generate': 'Generate Storyboard',

    // ── Storyboard ──
    'storyboard.heading': 'Storyboard',
    'storyboard.back': 'Back',
    'storyboard.editCharacters': 'Edit Characters',
    'storyboard.addShot': 'Add Shot',
    'storyboard.addExistingVideo': 'Add Existing Video',
    'storyboard.regenerateAll': 'Regenerate All',
    'storyboard.revisions': 'Revisions',
    'storyboard.saveAs': 'Save As',
    'storyboard.save': 'Save',
    'storyboard.saving': 'Saving…',
    'storyboard.saved': 'Saved (v{revision})',
    'storyboard.continueToFinalize': 'Continue to Finalize',
    'storyboard.nothingToSave': 'Nothing to save yet — generate a storyboard first.',
    'storyboard.allShotsReady': 'All {count} shots ready',
    'storyboard.assetsLoaded': '{done}/{total} assets loaded',

    // ── Shot card ──
    'shot.label': 'Shot {number}',
    'shot.editTitle': 'Click to edit the shot title',
    'shot.delete': 'Delete this shot',
    'shot.statusNew': 'New',
    'shot.statusPending': 'Pending',
    'shot.statusGenerating': 'Generating…',
    'shot.statusLoading': 'Loading…',
    'shot.statusReady': 'Ready',
    'shot.statusError': 'Error',
    'shot.imagePrompt': 'Image Prompt',
    'shot.editable': '(editable)',
    'shot.promptEnglishNote': 'Written in English for the image model',
    'shot.saveRegenerate': 'Save & Regenerate',
    'shot.askAi': 'Ask AI',
    'shot.audio': 'Audio',
    'shot.audioNative': 'native',
    'shot.audioVoiceover': 'voice-over',
    'shot.narrationScript': 'Narration Script',
    'shot.saveRegenerateAudio': 'Save & Regenerate Audio',
    'shot.generateBoth': 'Generate Image & Audio',
    'shot.regenerate': 'Regenerate',
    'shot.import': 'Import',
    'shot.local': 'Local',
    'shot.importShot': 'Import Shot',
    'shot.localFile': 'Local File',
    'shot.addVideo': 'Add Video',
    'shot.orFillPrompt': 'or fill in the prompt below and generate',
    'shot.waiting': 'Waiting…',
    'shot.fillNarration': 'Fill in the narration below',
    'shot.videoShot': 'Video shot',
    'shot.reEdit': 'Re-edit',
    'shot.generatingImage': 'Generating image…',
    'shot.generatingAudio': 'Generating audio…',
    'shot.imageLoadFailed': 'Image could not be loaded',
    'shot.audioLoadFailed': 'Audio could not be loaded',
    'shot.generationFailed': 'Generation failed — Regenerate',
    'shot.audioGenerationFailed': 'Audio generation failed',
    'shot.needPromptOrNarration':
      'Please fill in at least an image prompt or a narration script before generating.',
    'shot.cannotDeleteLast': 'You cannot delete the last shot.',
    'shot.confirmDelete': 'Delete "{title}"? This removes its image and audio.',
    'shot.deleted': 'Deleted {title}',
    'shot.regenerating': 'Regenerating shot {number}…',
    'shot.regeneratingAudio': 'Regenerating audio for shot {number}…',
    'shot.newShot': 'New Shot {number}',
    'shot.importedInto': 'Imported into position {number}',

    // ── AI modals ──
    'ai.promptTitle': 'AI Prompt Assistant',
    'ai.narrationTitle': 'AI Narration Assistant',
    'ai.currentPrompt': 'Current Prompt',
    'ai.currentNarration': 'Current Narration',
    'ai.yourGuidance': 'Your Guidance',
    'ai.promptGuidancePlaceholder': "Describe what you'd like to change…",
    'ai.narrationGuidancePlaceholder': "Describe how you'd like to change the narration…",
    'ai.cancel': 'Cancel',
    'ai.updateWithAi': 'Update with AI',
    'ai.updatingPrompt': 'AI is updating the prompt…',
    'ai.updatingNarration': 'AI is updating the narration…',
    'ai.generatingPrompt': 'AI generating prompt…',
    'ai.generatingNarration': 'AI generating narration…',

    // ── Characters ──
    'characters.reviewTitle': 'Character Review',
    'characters.reviewHelp':
      'Review the character descriptions and reference sheet. Edit descriptions or use Ask AI to refine them. Regenerate the sheet to see your changes, then approve.',
    'characters.editTitle': 'Edit Characters',
    'characters.editHelp':
      'Modify character descriptions, regenerate the character sheet, then return to the storyboard. Use Regenerate All Images to apply the new sheet to every shot.',
    'characters.referenceSheet': 'Character Reference Sheet',
    'characters.descriptions': 'Character Descriptions',
    'characters.regenerateSheet': 'Regenerate Character Sheet',
    'characters.regenerating': 'Regenerating…',
    'characters.regeneratingWith': 'Regenerating with the current descriptions…',
    'characters.sheetUnavailable': 'Character sheet not available',
    'characters.couldNotLoad': 'Could not load',
    'characters.regenerationFailed': 'Regeneration failed',
    'characters.approve': 'Approve & Generate Storyboard',
    'characters.returnToStoryboard': 'Return to Storyboard',
    'characters.applyRegenerate': 'Apply & Regenerate All Images',
    'characters.askAiToEdit': 'Ask AI to Edit',
    'characters.aiEditTitle': 'AI Character Edit',
    'characters.aiEditPrompt': 'Describe how you want to modify this character:',
    'characters.aiEditPlaceholder': 'e.g., make her hair blonde, change the outfit to a blue sundress…',
    'characters.aiEditOne': 'Edit: {name}',
    'characters.updating': 'Updating character…',
    'characters.updatingNamed': 'Updating {name} with AI…',
    'characters.generatingShots': 'Generating storyboard shots…',
    'characters.mayTake': 'This may take two to three minutes',
    'characters.noneAvailable': 'No character data available for this run.',
    'characters.noDataKey': '(No character data)',
    'characters.noDataValue':
      'Character descriptions were not saved for this run. You can still view and regenerate the character sheet.',
    'characters.regeneratingAll': 'Regenerating all images with the updated characters…',

    // ── Finalize ──
    'finalize.heading': 'Finalize Your Video',
    'finalize.backToStoryboard': 'Back to Storyboard',
    'finalize.preview': 'Preview',
    'finalize.clips': 'Clips',
    'finalize.duration': 'Duration',
    'finalize.imageShots': 'Image shots',
    'finalize.videoClips': 'Video clips',
    'finalize.resolution': 'Resolution',
    'finalize.fileSize': 'Est. file size',
    'finalize.renderTime': 'Est. time to create',
    'finalize.backgroundMusic': 'Background music',
    'finalize.music': 'Background Music',
    'finalize.uploadTrack': 'Upload Track',
    'finalize.musicVolume': 'Music Volume in Final Video',
    'finalize.musicVolumeHelp':
      'Sets how loud the background music plays under the narration in the final video. The slider also previews the level.',
    'finalize.wallpaper': 'Wallpaper',
    'finalize.uploadWallpaper': 'Upload Wallpaper',
    'finalize.noMusic': 'None (no background music)',
    'finalize.noWallpaper': 'None (no wallpaper)',
    'finalize.none': 'None',
    'finalize.on': 'On ({percent}%)',
    'finalize.createVideo': 'Create Video',
    'finalize.creatingVideo': 'Creating Video',
    'finalize.creatingDetail': 'Copying assets and launching assembly…',
    'finalize.assembling': 'Assembling video…',
    'finalize.assembled': 'Video assembled successfully',
    'finalize.assembledWithSize': 'Video assembled successfully ({size} MB)',
    'finalize.download': 'Download',
    'finalize.createAnother': 'Create Another',
    'finalize.shotsNotReady': '{count} shot(s) are not ready yet.',
    'finalize.assemblyFailedDetail': 'Video assembly failed:\n{error}',
    'finalize.uploading': 'Uploading…',
    'finalize.uploadDone': 'Done',
    'finalize.uploadFailed': 'Failed',
    'finalize.confirmDeleteTrack': 'Delete "{name}"?',

    // ── Progress ──
    'progress.processing': 'Processing…',
    'progress.pleaseWait': 'Please wait…',
    'progress.analyzingScript': 'Analyzing Script',
    'progress.analyzingDetail': 'Identifying characters and breaking the script into scenes…',
    'progress.savingStoryboard': 'Saving Storyboard',
    'progress.savingDetail': 'Saving {count} shot(s) as a new revision…',
    'progress.writingRevision': 'Writing the revision to project storage…',
    'progress.savedAsRevision': 'Saved as revision {revision}',
    'progress.restoringRevision': 'Restoring Revision',
    'progress.loadingRevision': 'Loading revision {revision}…',
    'progress.reloadingStoryboard': 'Reloading storyboard…',
    'progress.savingAsNew': 'Saving As New Project',
    'progress.copyingAssets': 'Copying all shots, images, audio, and video…',
    'progress.copyingProgress': 'Copying project assets…',
    'progress.openingNew': 'Opening the new project…',
    'progress.timedOut': 'Processing timed out after 12 minutes',

    // ── Revisions ──
    'revisions.title': 'Saved Revisions',
    'revisions.help':
      'Each time you click Save, a new revision is stored. You can restore any earlier version — restoring creates a new revision, so nothing is lost.',
    'revisions.loading': 'Loading…',
    'revisions.none': 'No saved revisions yet. Click Save to create your first one.',
    'revisions.item': 'Revision {revision}',
    'revisions.current': '(current)',
    'revisions.shotCount': '{count} shot(s)',
    'revisions.restore': 'Restore',
    'revisions.confirmRestore':
      'Restore revision {revision}? It becomes the latest version, and your current version stays in history.',
    'revisions.restored': 'Restored revision {revision}',
    'revisions.loadFailed': 'Could not load revisions: {error}',
    'revisions.noProject': 'No saved project yet — click Save first.',

    // ── Save As ──
    'saveAs.prompt': 'Save as a new project named:',
    'saveAs.copySuffix': '(Copy)',
    'saveAs.saved': 'Saved as "{name}"',
    'saveAs.needProject': 'Generate or open a project first.',

    // ── History ──
    'history.title': 'Previous Runs',
    'history.loading': 'Loading…',
    'history.none': 'No previous runs found.',
    'history.selected': '{count} selected',
    'history.selectAll': 'Select All',
    'history.deselectAll': 'Deselect All',
    'history.deleteSelected': 'Delete Selected',
    'history.deleting': 'Deleting {count}…',
    'history.confirmDeleteMany': 'Delete {count} run(s)? This cannot be undone.',
    'history.shots': '{count} shots',
    'history.complete': 'Complete',
    'history.error': 'Error',
    'history.partial': 'Partial',
    'history.openStoryboard': 'Open Storyboard',
    'history.preview': 'Preview',
    'history.hide': 'Hide',
    'history.download': 'Download',
    'history.delete': 'Delete',
    'history.loadFailed': 'Could not load runs: {error}',
    'history.confirmDeleteRun':
      'Delete run {id}?\n\nThis permanently removes all images, audio, and the final video.',
    'history.deleteFailed': 'Could not delete the run.',
    'history.noStoryboardData': 'No storyboard data found for this run.',
    'history.loadStoryboardFailed': 'Could not load the storyboard: {error}',
    'history.loadedRun': 'Loaded run {id}',

    // ── Import picker ──
    'import.title': 'Import Shot into Shot {number}',
    'import.help':
      'Select a shot from a previous run. Its image, audio, prompt, and narration replace the current shot.',
    'import.none': 'No importable shots found.',
    'import.loadFailed': 'Could not load importable shots: {error}',

    // ── Video wizard ──
    'wizard.title': 'Add Existing Video',
    'wizard.uploadVideo': 'Upload Video',
    'wizard.dropHint': 'Click to select or drag a video file',
    'wizard.formats': 'MP4, MOV, and WebM supported · up to about 10 minutes for transcription',
    'wizard.audioTrack': 'Audio Track',
    'wizard.spokenLanguage': 'Language spoken in the video',
    'wizard.spokenLanguageHelp':
      'What is spoken in the clip, which can differ from the project language. When they differ, the transcript is translated so the new voice-over matches your project.',
    'wizard.translating': 'Translating…',
    'wizard.translatedNotice': 'Transcribed in {source} and translated to {target}. Review before synthesizing.',
    'wizard.notTranslated': 'Transcribed in {source}, the same as the project language.',
    'wizard.translationFailed': 'Could not translate the transcript: {error}. The original text is shown; edit it before synthesizing.',
    'wizard.retranslate': 'Translate again',
    'wizard.voiceTargetNote': 'The voice-over is generated in {target}, the project language.',
    'wizard.useNative': 'Use Native Audio',
    'wizard.useNativeDesc': 'Keep the original audio track from the video',
    'wizard.transcribe': 'Transcribe & Re-voice',
    'wizard.transcribeDesc':
      'Extract speech from the video (up to about 10 minutes), then regenerate it with a synthetic voice',
    'wizard.manual': 'Manual Entry (Re-voice)',
    'wizard.manualDesc': 'Type custom narration text and generate it with a synthetic voice',
    'wizard.voice': 'Voice',
    'wizard.transcribeButton': 'Transcribe Audio from Video',
    'wizard.retryTranscription': 'Retry Transcription',
    'wizard.transcribed': 'Transcribed — click to transcribe again',
    'wizard.transcribing': 'Transcribing…',
    'wizard.startingTranscription': 'Starting transcription…',
    'wizard.transcribingDetail': 'Transcribing audio… this can take 30 to 90 seconds for longer videos',
    'wizard.transcribingElapsed': 'Transcribing audio… ({seconds}s elapsed)',
    'wizard.transcriptionReady': 'Transcription ready. Edit if needed, then synthesize the voice-over.',
    'wizard.transcriptionTimeout': 'Transcription timed out after 10 minutes',
    'wizard.stillUploading': 'The video is still uploading — wait for the upload to finish.',
    'wizard.narrationText': 'Narration Text',
    'wizard.transcribedText': 'Transcribed Text (editable)',
    'wizard.narrationPlaceholder': 'Type or edit the narration text…',
    'wizard.transcribePlaceholder': 'Click Transcribe above to extract text from the video…',
    'wizard.manualPlaceholder': 'Type the narration you want spoken over this video…',
    'wizard.synthesize': 'Synthesize Voice-over',
    'wizard.reSynthesize': 'Re-Synthesize',
    'wizard.synthesizing': 'Synthesizing…',
    'wizard.generatingVoiceover': 'Generating voice-over, please wait…',
    'wizard.generatingLongVoiceover': 'Generating long voice-over in parts… ({seconds}s)',
    'wizard.voiceoverReady':
      'Voice-over ready — play to preview. Edit the text and re-synthesize if needed.',
    'wizard.textChanged': 'Text changed — re-synthesize to preview.',
    'wizard.needText': 'Enter or transcribe some text first.',
    'wizard.videoPreview': 'Video Preview',
    'wizard.generatePreview': 'Generate Preview (Video + Audio)',
    'wizard.regeneratePreview': 'Regenerate Preview',
    'wizard.generatingPreview': 'Generating…',
    'wizard.mergingPreview': 'Merging video and audio… this can take 30 to 60 seconds',
    'wizard.mergingElapsed': 'Merging video and audio… ({seconds}s elapsed)',
    'wizard.previewReady': 'Preview ready — merged video and audio. Play to review.',
    'wizard.previewTimeout': 'Preview generation timed out',
    'wizard.uploadingVideo': 'Uploading video…',
    'wizard.uploaded': 'Video uploaded — choose the audio options below.',
    'wizard.uploadFailed': 'Upload failed: {error}',
    'wizard.uploadNoUrl': 'Upload failed — no URL returned',
    'wizard.noVideo': 'No video uploaded yet.',
    'wizard.synthesizeFirst': 'Synthesize the voice-over first.',
    'wizard.cancel': 'Cancel',
    'wizard.finish': 'Finish & Add to Storyboard',
    'wizard.adding': 'Adding…',
    'wizard.nativeAudioLabel': '(native video audio)',
    'wizard.defaultTitle': 'Video Shot',

    // ── Generic ──
    'common.loading': 'Loading…',
    'common.cancel': 'Cancel',
    'common.close': 'Close',
    'common.delete': 'Delete',
    'common.error': 'Error: {error}',
  },

  fr: {
    // ── App shell ──
    'app.name': 'Orchestrateur vidéo IA',
    'app.shortName': 'VAIO',
    'app.tagline': 'Du storyboard à la vidéo, en français ou en anglais',

    // ── Auth ──
    'auth.signInPrompt': 'Connectez-vous pour continuer',
    'auth.email': 'Courriel',
    'auth.password': 'Mot de passe',
    'auth.signIn': 'Se connecter',
    'auth.noAccount': 'Pas de compte ?',
    'auth.signUp': 'Créer un compte',
    'auth.signOut': 'Se déconnecter',
    'auth.inviteOnly': 'Les comptes sont créés par un administrateur. Communiquez avec votre administrateur pour demander un accès.',
    'auth.signUpDisabled': 'L\u2019inscription libre est désactivée dans cet environnement.',
    'auth.newPasswordRequired': 'Un nouveau mot de passe est requis.',
    'auth.newPassword': 'Nouveau mot de passe',
    'auth.setPassword': 'Définir le mot de passe',
    'auth.checkEmail': 'Consultez votre courriel pour obtenir le code de vérification.',
    'auth.verificationCode': 'Code de vérification',
    'auth.confirm': 'Confirmer',
    'auth.confirmed': 'Compte confirmé. Vous pouvez vous connecter.',
    'auth.signInFailed': 'Échec de la connexion',
    'auth.failed': 'Échec',

    // ── Top bar ──
    'nav.previousRuns': 'Projets précédents',
    'nav.language': 'Langue',
    'nav.theme': 'Thème',
    'nav.themeLight': 'Clair',
    'nav.themeDark': 'Sombre',
    'nav.themeSystem': 'Système',
    'nav.switchToLight': 'Passer au thème clair',
    'nav.switchToDark': 'Passer au thème sombre',

    // ── Status badge ──
    'status.ready': 'Prêt',
    'status.processing': 'Traitement…',
    'status.analyzingStyle': 'Analyse du style…',
    'status.styleExtracted': 'Style extrait',
    'status.styleFailed': 'Échec de l\u2019analyse du style',
    'status.readingDocument': 'Lecture du document…',
    'status.documentLoaded': 'Document chargé',
    'status.uploadFailed': 'Échec du téléversement',
    'status.processingFailed': 'Échec du traitement',
    'status.generatingAssets': 'Génération des éléments…',
    'status.allAssetsReady': 'Tous les éléments sont prêts',
    'status.creating': 'Création…',
    'status.videoCreated': 'Vidéo créée',
    'status.assemblyFailed': 'Échec du montage',
    'status.lostConnection': 'Connexion perdue',
    'status.failed': 'Échec',
    'status.renaming': 'Renommage…',
    'status.projectRenamed': 'Projet renommé',
    'status.renameFailed': 'Échec du renommage',
    'status.saveFailed': 'Échec de l\u2019enregistrement — veuillez réessayer',
    'status.saveAsFailed': 'Échec de l\u2019enregistrement sous',
    'status.restoreFailed': 'Échec de la restauration',
    'status.promptUpdated': 'Prompt mis à jour',
    'status.narrationUpdated': 'Narration mise à jour',
    'status.aiHelpFailed': 'Échec de l\u2019assistant IA',
    'status.videoShotAdded': 'Plan vidéo ajouté',
    'status.loadingShots': 'Chargement des plans des projets précédents…',
    'status.loadShotsFailed': 'Impossible de charger les plans',

    // ── Project panel ──
    'project.heading': 'Projet',
    'project.namePlaceholder': 'Nom du projet (ex. : Campagne touristique estivale)',
    'project.descriptionPlaceholder': 'Brève description (facultatif)',
    'project.untitled': 'Projet sans titre',
    'project.editName': 'Modifier le nom du projet',

    // ── Language picker ──
    'language.heading': 'Langue du projet',
    'language.help':
      'Choisissez la langue de votre scénario. La narration, les titres de plans et les descriptions de personnages sont générés dans cette langue. Les prompts d\u2019image sont toujours produits en anglais, car les modèles d\u2019image suivent l\u2019anglais bien plus fidèlement.',
    'language.english': 'Anglais',
    'language.french': 'Français',
    'language.englishDesc': 'Générer la narration et les titres en anglais',
    'language.frenchDesc': 'Générer la narration et les titres en français',
    'language.lockedNotice':
      'Définie à la création du projet. Créez un nouveau projet pour la changer.',

    // ── Upload ──
    'upload.heading': 'Téléversez votre scénario',
    'upload.help': 'Glissez-déposez un fichier .txt, .md ou .docx, ou cliquez pour parcourir',
    'upload.browse': 'Parcourir les fichiers',
    'upload.supports': 'Formats acceptés : .txt, .md, .docx',
    'upload.or': 'ou',
    'upload.pastePlaceholder': 'Collez votre scénario marketing ici…',
    'upload.unsupportedType': 'Type de fichier non pris en charge : .{ext}',
    'upload.readFailed': 'Impossible de lire le document : {error}',

    // ── Style picker ──
    'style.heading': 'Style visuel',
    'style.pastelCartoon': 'Dessin animé pastel',
    'style.pastelCartoonDesc': 'Couleurs pastel douces, contours nets, style 2D plat',
    'style.boldCorporate': 'Corporatif audacieux',
    'style.boldCorporateDesc':
      'Dégradés dynamiques, formes géométriques affirmées, allure haut de gamme',
    'style.customImage': 'Image de référence personnalisée',
    'style.customImageDesc': 'Téléversez une image et l\u2019IA en extraira le style visuel',
    'style.upload': 'Téléverser',
    'style.extracted': 'Style extrait',
    'style.analyzeFailed': 'Impossible d\u2019analyser l\u2019image : {error}',

    // ── Image model picker ──
    'model.heading': 'Modèle d\u2019image',
    'model.standard': 'Standard',
    'model.standardTag': '(ancien)',
    'model.standardDesc': 'Amazon Nova Canvas — rapide et fiable, bon respect des prompts',
    'model.advanced': 'Avancé',
    'model.advancedDesc':
      'Génération d\u2019images créatives de haute qualité — idéal pour les scènes complexes',
    'model.experimental': 'SDXL + IP-Adapter',
    'model.experimentalTag': '(expérimental)',
    'model.experimentalDesc':
      'Génération cohérente des personnages grâce à des références préservant l\u2019identité',
    'model.badgeAdvanced': 'Avancé',
    'model.badgeStandard': 'Standard (ancien)',
    'model.badgeExperimental': 'SDXL + IP-Adapter (expérimental)',
    'model.fallbackNotice': 'Échec de {selected}, {used} utilisé',

    // ── Settings ──
    'settings.heading': 'Paramètres',
    'settings.shotCount': 'Nombre de plans',
    'settings.shotDuration': 'Durée par plan',
    'settings.totalDuration': 'Durée totale',

    // ── Narrative style ──
    'narrative.heading': 'Style narratif',
    'narrative.default':
      'Créer une vidéo marketing dynamique centrée sur l\u2019expérience de l\u2019utilisateur final, destinée à un public d\u2019utilisateurs finaux.',

    // ── Reference images ──
    'refs.heading': 'Images de référence',
    'refs.optional': '(facultatif)',
    'refs.help':
      'Téléversez des logos, des paysages, des produits ou d\u2019autres références visuelles. Elles sont étiquetées et transmises au modèle d\u2019image pour assurer la cohérence.',
    'refs.add': 'Ajouter une image de référence',
    'refs.labelPlaceholder': 'Nommez cette image…',

    // ── Voice ──
    'voice.heading': 'Voix',
    'voice.loading': 'Chargement des voix…',
    'voice.loadFailed': 'Impossible de charger les voix',
    'voice.sample': 'Écouter',
    'voice.playing': 'Lecture',
    'voice.sampleFailed': 'Échec',
    'voice.narrationVoice': 'Voix de narration',
    'voice.setTo': 'Voix de narration : {name}',

    // ── Process button ──
    'process.generate': 'Générer le storyboard',

    // ── Storyboard ──
    'storyboard.heading': 'Storyboard',
    'storyboard.back': 'Retour',
    'storyboard.editCharacters': 'Modifier les personnages',
    'storyboard.addShot': 'Ajouter un plan',
    'storyboard.addExistingVideo': 'Ajouter une vidéo existante',
    'storyboard.regenerateAll': 'Tout régénérer',
    'storyboard.revisions': 'Révisions',
    'storyboard.saveAs': 'Enregistrer sous',
    'storyboard.save': 'Enregistrer',
    'storyboard.saving': 'Enregistrement…',
    'storyboard.saved': 'Enregistré (v{revision})',
    'storyboard.continueToFinalize': 'Passer à la finalisation',
    'storyboard.nothingToSave':
      'Rien à enregistrer pour le moment — générez d\u2019abord un storyboard.',
    'storyboard.allShotsReady': 'Les {count} plans sont prêts',
    'storyboard.assetsLoaded': '{done}/{total} éléments chargés',

    // ── Shot card ──
    'shot.label': 'Plan {number}',
    'shot.editTitle': 'Cliquez pour modifier le titre du plan',
    'shot.delete': 'Supprimer ce plan',
    'shot.statusNew': 'Nouveau',
    'shot.statusPending': 'En attente',
    'shot.statusGenerating': 'Génération…',
    'shot.statusLoading': 'Chargement…',
    'shot.statusReady': 'Prêt',
    'shot.statusError': 'Erreur',
    'shot.imagePrompt': 'Prompt d\u2019image',
    'shot.editable': '(modifiable)',
    'shot.promptEnglishNote': 'Rédigé en anglais pour le modèle d\u2019image',
    'shot.saveRegenerate': 'Enregistrer et régénérer',
    'shot.askAi': 'Demander à l\u2019IA',
    'shot.audio': 'Audio',
    'shot.audioNative': 'natif',
    'shot.audioVoiceover': 'voix hors champ',
    'shot.narrationScript': 'Texte de narration',
    'shot.saveRegenerateAudio': 'Enregistrer et régénérer l\u2019audio',
    'shot.generateBoth': 'Générer l\u2019image et l\u2019audio',
    'shot.regenerate': 'Régénérer',
    'shot.import': 'Importer',
    'shot.local': 'Local',
    'shot.importShot': 'Importer un plan',
    'shot.localFile': 'Fichier local',
    'shot.addVideo': 'Ajouter une vidéo',
    'shot.orFillPrompt': 'ou remplissez le prompt ci-dessous et générez',
    'shot.waiting': 'En attente…',
    'shot.fillNarration': 'Remplissez la narration ci-dessous',
    'shot.videoShot': 'Plan vidéo',
    'shot.reEdit': 'Modifier',
    'shot.generatingImage': 'Génération de l\u2019image…',
    'shot.generatingAudio': 'Génération de l\u2019audio…',
    'shot.imageLoadFailed': 'Impossible de charger l\u2019image',
    'shot.audioLoadFailed': 'Impossible de charger l\u2019audio',
    'shot.generationFailed': 'Échec de la génération — régénérer',
    'shot.audioGenerationFailed': 'Échec de la génération de l\u2019audio',
    'shot.needPromptOrNarration':
      'Veuillez remplir au moins un prompt d\u2019image ou un texte de narration avant de générer.',
    'shot.cannotDeleteLast': 'Vous ne pouvez pas supprimer le dernier plan.',
    'shot.confirmDelete': 'Supprimer « {title} » ? Son image et son audio seront retirés.',
    'shot.deleted': '{title} supprimé',
    'shot.regenerating': 'Régénération du plan {number}…',
    'shot.regeneratingAudio': 'Régénération de l\u2019audio du plan {number}…',
    'shot.newShot': 'Nouveau plan {number}',
    'shot.importedInto': 'Importé à la position {number}',

    // ── AI modals ──
    'ai.promptTitle': 'Assistant IA — prompt',
    'ai.narrationTitle': 'Assistant IA — narration',
    'ai.currentPrompt': 'Prompt actuel',
    'ai.currentNarration': 'Narration actuelle',
    'ai.yourGuidance': 'Vos consignes',
    'ai.promptGuidancePlaceholder': 'Décrivez ce que vous voulez changer…',
    'ai.narrationGuidancePlaceholder': 'Décrivez comment vous voulez modifier la narration…',
    'ai.cancel': 'Annuler',
    'ai.updateWithAi': 'Mettre à jour avec l\u2019IA',
    'ai.updatingPrompt': 'L\u2019IA met à jour le prompt…',
    'ai.updatingNarration': 'L\u2019IA met à jour la narration…',
    'ai.generatingPrompt': 'L\u2019IA génère le prompt…',
    'ai.generatingNarration': 'L\u2019IA génère la narration…',

    // ── Characters ──
    'characters.reviewTitle': 'Révision des personnages',
    'characters.reviewHelp':
      'Vérifiez les descriptions et la fiche de référence. Modifiez les descriptions ou utilisez Demander à l\u2019IA pour les affiner. Régénérez la fiche pour voir vos changements, puis approuvez.',
    'characters.editTitle': 'Modifier les personnages',
    'characters.editHelp':
      'Modifiez les descriptions, régénérez la fiche des personnages, puis revenez au storyboard. Utilisez Appliquer et tout régénérer pour appliquer la nouvelle fiche à tous les plans.',
    'characters.referenceSheet': 'Fiche de référence des personnages',
    'characters.descriptions': 'Descriptions des personnages',
    'characters.regenerateSheet': 'Régénérer la fiche des personnages',
    'characters.regenerating': 'Régénération…',
    'characters.regeneratingWith': 'Régénération avec les descriptions actuelles…',
    'characters.sheetUnavailable': 'Fiche des personnages non disponible',
    'characters.couldNotLoad': 'Chargement impossible',
    'characters.regenerationFailed': 'Échec de la régénération',
    'characters.approve': 'Approuver et générer le storyboard',
    'characters.returnToStoryboard': 'Revenir au storyboard',
    'characters.applyRegenerate': 'Appliquer et régénérer toutes les images',
    'characters.askAiToEdit': 'Demander à l\u2019IA',
    'characters.aiEditTitle': 'Modification IA du personnage',
    'characters.aiEditPrompt': 'Décrivez comment modifier ce personnage :',
    'characters.aiEditPlaceholder':
      'ex. : rendre ses cheveux blonds, changer la tenue pour une robe bleue…',
    'characters.aiEditOne': 'Modifier : {name}',
    'characters.updating': 'Mise à jour du personnage…',
    'characters.updatingNamed': 'Mise à jour de {name} avec l\u2019IA…',
    'characters.generatingShots': 'Génération des plans du storyboard…',
    'characters.mayTake': 'Cela peut prendre deux à trois minutes',
    'characters.noneAvailable': 'Aucune donnée de personnage pour ce projet.',
    'characters.noDataKey': '(Aucune donnée de personnage)',
    'characters.noDataValue':
      'Les descriptions de personnages n\u2019ont pas été enregistrées pour ce projet. Vous pouvez tout de même consulter et régénérer la fiche.',
    'characters.regeneratingAll':
      'Régénération de toutes les images avec les personnages mis à jour…',

    // ── Finalize ──
    'finalize.heading': 'Finalisez votre vidéo',
    'finalize.backToStoryboard': 'Retour au storyboard',
    'finalize.preview': 'Aperçu',
    'finalize.clips': 'Séquences',
    'finalize.duration': 'Durée',
    'finalize.imageShots': 'Plans image',
    'finalize.videoClips': 'Séquences vidéo',
    'finalize.resolution': 'Résolution',
    'finalize.fileSize': 'Taille estimée',
    'finalize.renderTime': 'Temps de création estimé',
    'finalize.backgroundMusic': 'Musique de fond',
    'finalize.music': 'Musique de fond',
    'finalize.uploadTrack': 'Téléverser une piste',
    'finalize.musicVolume': 'Volume de la musique dans la vidéo finale',
    'finalize.musicVolumeHelp':
      'Définit le volume de la musique de fond sous la narration dans la vidéo finale. Le curseur permet aussi d\u2019en écouter un aperçu.',
    'finalize.wallpaper': 'Image de fond',
    'finalize.uploadWallpaper': 'Téléverser une image de fond',
    'finalize.noMusic': 'Aucune (pas de musique de fond)',
    'finalize.noWallpaper': 'Aucune (pas d\u2019image de fond)',
    'finalize.none': 'Aucune',
    'finalize.on': 'Activée ({percent} %)',
    'finalize.createVideo': 'Créer la vidéo',
    'finalize.creatingVideo': 'Création de la vidéo',
    'finalize.creatingDetail': 'Copie des éléments et lancement du montage…',
    'finalize.assembling': 'Montage de la vidéo…',
    'finalize.assembled': 'Vidéo montée avec succès',
    'finalize.assembledWithSize': 'Vidéo montée avec succès ({size} Mo)',
    'finalize.download': 'Télécharger',
    'finalize.createAnother': 'En créer une autre',
    'finalize.shotsNotReady': '{count} plan(s) ne sont pas encore prêts.',
    'finalize.assemblyFailedDetail': 'Échec du montage de la vidéo :\n{error}',
    'finalize.uploading': 'Téléversement…',
    'finalize.uploadDone': 'Terminé',
    'finalize.uploadFailed': 'Échec',
    'finalize.confirmDeleteTrack': 'Supprimer « {name} » ?',

    // ── Progress ──
    'progress.processing': 'Traitement…',
    'progress.pleaseWait': 'Veuillez patienter…',
    'progress.analyzingScript': 'Analyse du scénario',
    'progress.analyzingDetail': 'Identification des personnages et découpage en scènes…',
    'progress.savingStoryboard': 'Enregistrement du storyboard',
    'progress.savingDetail': 'Enregistrement de {count} plan(s) comme nouvelle révision…',
    'progress.writingRevision': 'Écriture de la révision dans le stockage du projet…',
    'progress.savedAsRevision': 'Enregistré comme révision {revision}',
    'progress.restoringRevision': 'Restauration de la révision',
    'progress.loadingRevision': 'Chargement de la révision {revision}…',
    'progress.reloadingStoryboard': 'Rechargement du storyboard…',
    'progress.savingAsNew': 'Enregistrement comme nouveau projet',
    'progress.copyingAssets': 'Copie de tous les plans, images, fichiers audio et vidéos…',
    'progress.copyingProgress': 'Copie des éléments du projet…',
    'progress.openingNew': 'Ouverture du nouveau projet…',
    'progress.timedOut': 'Délai de traitement dépassé après 12 minutes',

    // ── Revisions ──
    'revisions.title': 'Révisions enregistrées',
    'revisions.help':
      'Chaque fois que vous cliquez sur Enregistrer, une nouvelle révision est conservée. Vous pouvez restaurer une version antérieure — la restauration crée une nouvelle révision, donc rien n\u2019est perdu.',
    'revisions.loading': 'Chargement…',
    'revisions.none':
      'Aucune révision enregistrée. Cliquez sur Enregistrer pour créer la première.',
    'revisions.item': 'Révision {revision}',
    'revisions.current': '(actuelle)',
    'revisions.shotCount': '{count} plan(s)',
    'revisions.restore': 'Restaurer',
    'revisions.confirmRestore':
      'Restaurer la révision {revision} ? Elle devient la version la plus récente et votre version actuelle reste dans l\u2019historique.',
    'revisions.restored': 'Révision {revision} restaurée',
    'revisions.loadFailed': 'Impossible de charger les révisions : {error}',
    'revisions.noProject':
      'Aucun projet enregistré — cliquez d\u2019abord sur Enregistrer.',

    // ── Save As ──
    'saveAs.prompt': 'Enregistrer comme nouveau projet nommé :',
    'saveAs.copySuffix': '(copie)',
    'saveAs.saved': 'Enregistré sous « {name} »',
    'saveAs.needProject': 'Générez ou ouvrez d\u2019abord un projet.',

    // ── History ──
    'history.title': 'Projets précédents',
    'history.loading': 'Chargement…',
    'history.none': 'Aucun projet précédent.',
    'history.selected': '{count} sélectionné(s)',
    'history.selectAll': 'Tout sélectionner',
    'history.deselectAll': 'Tout désélectionner',
    'history.deleteSelected': 'Supprimer la sélection',
    'history.deleting': 'Suppression de {count}…',
    'history.confirmDeleteMany':
      'Supprimer {count} projet(s) ? Cette action est irréversible.',
    'history.shots': '{count} plans',
    'history.complete': 'Terminé',
    'history.error': 'Erreur',
    'history.partial': 'Partiel',
    'history.openStoryboard': 'Ouvrir le storyboard',
    'history.preview': 'Aperçu',
    'history.hide': 'Masquer',
    'history.download': 'Télécharger',
    'history.delete': 'Supprimer',
    'history.loadFailed': 'Impossible de charger les projets : {error}',
    'history.confirmDeleteRun':
      'Supprimer le projet {id} ?\n\nToutes les images, les fichiers audio et la vidéo finale seront supprimés définitivement.',
    'history.deleteFailed': 'Impossible de supprimer le projet.',
    'history.noStoryboardData': 'Aucune donnée de storyboard pour ce projet.',
    'history.loadStoryboardFailed': 'Impossible de charger le storyboard : {error}',
    'history.loadedRun': 'Projet {id} chargé',

    // ── Import picker ──
    'import.title': 'Importer un plan dans le plan {number}',
    'import.help':
      'Sélectionnez un plan d\u2019un projet précédent. Son image, son audio, son prompt et sa narration remplaceront le plan actuel.',
    'import.none': 'Aucun plan importable.',
    'import.loadFailed': 'Impossible de charger les plans importables : {error}',

    // ── Video wizard ──
    'wizard.title': 'Ajouter une vidéo existante',
    'wizard.uploadVideo': 'Téléverser une vidéo',
    'wizard.dropHint': 'Cliquez pour choisir ou glissez un fichier vidéo',
    'wizard.formats':
      'MP4, MOV et WebM pris en charge · jusqu\u2019à environ 10 minutes pour la transcription',
    'wizard.audioTrack': 'Piste audio',
    'wizard.spokenLanguage': 'Langue parlée dans la vidéo',
    'wizard.spokenLanguageHelp':
      'La langue parlée dans le clip, qui peut différer de celle du projet. Lorsqu\u2019elles diffèrent, la transcription est traduite afin que la nouvelle voix hors champ corresponde à votre projet.',
    'wizard.translating': 'Traduction…',
    'wizard.translatedNotice': 'Transcrit en {source} puis traduit en {target}. Vérifiez avant de générer la voix.',
    'wizard.notTranslated': 'Transcrit en {source}, la même langue que le projet.',
    'wizard.translationFailed': 'Impossible de traduire la transcription : {error}. Le texte original est affiché ; modifiez-le avant de générer la voix.',
    'wizard.retranslate': 'Traduire à nouveau',
    'wizard.voiceTargetNote': 'La voix hors champ est générée en {target}, la langue du projet.',
    'wizard.useNative': 'Utiliser l\u2019audio natif',
    'wizard.useNativeDesc': 'Conserver la piste audio d\u2019origine de la vidéo',
    'wizard.transcribe': 'Transcrire et revoicer',
    'wizard.transcribeDesc':
      'Extraire la parole de la vidéo (jusqu\u2019à environ 10 minutes), puis la régénérer avec une voix de synthèse',
    'wizard.manual': 'Saisie manuelle (revoicer)',
    'wizard.manualDesc':
      'Saisir un texte de narration personnalisé et le générer avec une voix de synthèse',
    'wizard.voice': 'Voix',
    'wizard.transcribeButton': 'Transcrire l\u2019audio de la vidéo',
    'wizard.retryTranscription': 'Réessayer la transcription',
    'wizard.transcribed': 'Transcrit — cliquez pour transcrire à nouveau',
    'wizard.transcribing': 'Transcription…',
    'wizard.startingTranscription': 'Démarrage de la transcription…',
    'wizard.transcribingDetail':
      'Transcription de l\u2019audio… cela peut prendre de 30 à 90 secondes pour les vidéos plus longues',
    'wizard.transcribingElapsed': 'Transcription de l\u2019audio… ({seconds} s écoulées)',
    'wizard.transcriptionReady':
      'Transcription prête. Modifiez-la si nécessaire, puis générez la voix hors champ.',
    'wizard.transcriptionTimeout': 'Délai de transcription dépassé après 10 minutes',
    'wizard.stillUploading':
      'La vidéo est encore en cours de téléversement — attendez la fin.',
    'wizard.narrationText': 'Texte de narration',
    'wizard.transcribedText': 'Texte transcrit (modifiable)',
    'wizard.narrationPlaceholder': 'Saisissez ou modifiez le texte de narration…',
    'wizard.transcribePlaceholder':
      'Cliquez sur Transcrire ci-dessus pour extraire le texte de la vidéo…',
    'wizard.manualPlaceholder':
      'Saisissez la narration à prononcer sur cette vidéo…',
    'wizard.synthesize': 'Générer la voix hors champ',
    'wizard.reSynthesize': 'Régénérer la voix',
    'wizard.synthesizing': 'Génération…',
    'wizard.generatingVoiceover': 'Génération de la voix hors champ, veuillez patienter…',
    'wizard.generatingLongVoiceover':
      'Génération de la voix hors champ en plusieurs parties… ({seconds} s)',
    'wizard.voiceoverReady':
      'Voix hors champ prête — écoutez l\u2019aperçu. Modifiez le texte et régénérez si nécessaire.',
    'wizard.textChanged': 'Texte modifié — régénérez pour écouter l\u2019aperçu.',
    'wizard.needText': 'Saisissez ou transcrivez d\u2019abord du texte.',
    'wizard.videoPreview': 'Aperçu vidéo',
    'wizard.generatePreview': 'Générer l\u2019aperçu (vidéo + audio)',
    'wizard.regeneratePreview': 'Régénérer l\u2019aperçu',
    'wizard.generatingPreview': 'Génération…',
    'wizard.mergingPreview':
      'Fusion de la vidéo et de l\u2019audio… cela peut prendre de 30 à 60 secondes',
    'wizard.mergingElapsed': 'Fusion de la vidéo et de l\u2019audio… ({seconds} s écoulées)',
    'wizard.previewReady': 'Aperçu prêt — vidéo et audio fusionnés. Lancez la lecture.',
    'wizard.previewTimeout': 'Délai de génération de l\u2019aperçu dépassé',
    'wizard.uploadingVideo': 'Téléversement de la vidéo…',
    'wizard.uploaded': 'Vidéo téléversée — choisissez les options audio ci-dessous.',
    'wizard.uploadFailed': 'Échec du téléversement : {error}',
    'wizard.uploadNoUrl': 'Échec du téléversement — aucune URL retournée',
    'wizard.noVideo': 'Aucune vidéo téléversée.',
    'wizard.synthesizeFirst': 'Générez d\u2019abord la voix hors champ.',
    'wizard.cancel': 'Annuler',
    'wizard.finish': 'Terminer et ajouter au storyboard',
    'wizard.adding': 'Ajout…',
    'wizard.nativeAudioLabel': '(audio natif de la vidéo)',
    'wizard.defaultTitle': 'Plan vidéo',

    // ── Generic ──
    'common.loading': 'Chargement…',
    'common.cancel': 'Annuler',
    'common.close': 'Fermer',
    'common.delete': 'Supprimer',
    'common.error': 'Erreur : {error}',
  },
};

const SUPPORTED_UI_LANGUAGES = ['en', 'fr'];
const UI_LANG_STORAGE_KEY = 'vaio.uiLanguage';
const DEFAULT_UI_LANGUAGE = 'en';

/** BCP 47 tags used for date and number formatting. */
const LOCALE_TAGS = { en: 'en-CA', fr: 'fr-CA' };

/**
 * Coerce a value into a supported UI language code.
 *
 * @param {unknown} value Candidate language, code or locale.
 * @returns {'en'|'fr'} A supported language code.
 */
function normalizeUiLanguage(value) {
  if (!value) return DEFAULT_UI_LANGUAGE;
  const candidate = String(value).trim().toLowerCase();
  if (SUPPORTED_UI_LANGUAGES.includes(candidate)) return candidate;
  const prefix = candidate.split(/[-_]/)[0];
  return SUPPORTED_UI_LANGUAGES.includes(prefix) ? prefix : DEFAULT_UI_LANGUAGE;
}

/**
 * Resolve the initial interface language.
 *
 * Order of preference: a previously saved choice, then the browser's language, then
 * English.
 *
 * @returns {'en'|'fr'} The language to start in.
 */
function detectInitialUiLanguage() {
  try {
    const stored = localStorage.getItem(UI_LANG_STORAGE_KEY);
    if (stored && SUPPORTED_UI_LANGUAGES.includes(stored)) return stored;
  } catch {
    // Private browsing can make localStorage throw; fall through to detection.
  }
  const browserLang = (navigator.languages && navigator.languages[0]) || navigator.language;
  return normalizeUiLanguage(browserLang);
}

let uiLang = detectInitialUiLanguage();

/**
 * Translate a key into the current interface language.
 *
 * Missing keys fall back to English, then to the key itself, so a gap in the
 * dictionary degrades into a visible but harmless label rather than "undefined".
 *
 * @param {string} key Dictionary key, e.g. 'shot.label'.
 * @param {Record<string, string|number>} [params] Values for {placeholders}.
 * @returns {string} The translated string.
 */
function t(key, params) {
  const table = I18N_STRINGS[uiLang] || I18N_STRINGS[DEFAULT_UI_LANGUAGE];
  let text = table[key];
  if (text === undefined) {
    text = I18N_STRINGS[DEFAULT_UI_LANGUAGE][key];
    if (text === undefined) {
      console.warn(`i18n: missing key "${key}"`);
      return key;
    }
    console.warn(`i18n: key "${key}" missing for "${uiLang}", used English`);
  }
  if (!params) return text;
  return text.replace(/\{(\w+)\}/g, (match, name) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match
  );
}

/** @returns {'en'|'fr'} The current interface language. */
function getUiLanguage() {
  return uiLang;
}

/** @returns {string} BCP 47 locale tag for the current interface language. */
function getLocaleTag() {
  return LOCALE_TAGS[uiLang] || LOCALE_TAGS.en;
}

/**
 * Apply the current language to every translatable node under a root.
 *
 * @param {ParentNode} [root=document] Subtree to translate. Pass a freshly built
 *   element to translate only that element.
 */
function applyTranslations(root = document) {
  root.querySelectorAll('[data-i18n]').forEach((el) => {
    el.textContent = t(el.dataset.i18n);
  });
  root.querySelectorAll('[data-i18n-html]').forEach((el) => {
    el.innerHTML = t(el.dataset.i18nHtml);
  });
  root.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {
    el.placeholder = t(el.dataset.i18nPlaceholder);
  });
  root.querySelectorAll('[data-i18n-title]').forEach((el) => {
    el.title = t(el.dataset.i18nTitle);
  });
  root.querySelectorAll('[data-i18n-aria-label]').forEach((el) => {
    el.setAttribute('aria-label', t(el.dataset.i18nAriaLabel));
  });

  if (root === document) {
    document.documentElement.lang = uiLang;
    const title = document.querySelector('title[data-i18n]');
    if (title) document.title = t(title.dataset.i18n);
  }
}

/**
 * Switch the interface language and re-render.
 *
 * Only affects console chrome. A project's generated content stays in the language
 * it was created in, because regenerating it would discard existing narration and
 * audio.
 *
 * @param {string} lang Target language code.
 * @param {{silent?: boolean}} [options] Pass silent to skip the change event.
 */
function setUiLanguage(lang, options = {}) {
  const next = normalizeUiLanguage(lang);
  if (next === uiLang) return;
  uiLang = next;
  try {
    localStorage.setItem(UI_LANG_STORAGE_KEY, next);
  } catch {
    // Non-fatal: the choice just will not survive a reload.
  }
  applyTranslations();
  if (!options.silent) {
    window.dispatchEvent(new CustomEvent('vaio-language-changed', { detail: { language: next } }));
  }
}

window.VaioI18n = {
  t,
  getUiLanguage,
  getLocaleTag,
  setUiLanguage,
  applyTranslations,
  normalizeUiLanguage,
  SUPPORTED_UI_LANGUAGES,
};

// Translate as soon as the markup exists, before the app boots, so no English
// text flashes for a French user.
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => applyTranslations());
} else {
  applyTranslations();
}

})();
