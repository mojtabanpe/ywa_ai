# ywa_ai

Daily Persian AI Reel discovery MVP. The current source is an RSS provider; its interface supports future Reddit, YouTube, and browser-backed Instagram providers.

## Run locally

1. `pnpm install`
2. `docker compose up -d`
3. `pnpm exec prisma migrate dev --name init`
4. In separate terminals: `pnpm nx serve api` and `pnpm nx serve admin`
5. Open `http://localhost:4200`, then choose **اجرای Discovery**.

This repo uses pnpm (see `packageManager` in `package.json`). Enable it with `corepack enable` if you do not have it installed.

API: `POST /api/discovery/runs`, `GET /api/discovery/runs`, `GET /api/discovery/topics`.

Topics are scored through a selectable LLM provider. Use `LLM_PROVIDER=gateway` with `LLM_API_BASE_URL`, `LLM_API_KEY`, and `LLM_MODEL` for the supplied gateway; use `LLM_PROVIDER=openai` with `OPENAI_API_KEY` and optional `OPENAI_MODEL` (default: `gpt-5-mini`) for OpenAI. If scoring is unavailable or its output is invalid, discovery uses a deterministic fallback score so the run still completes.

Each new Discovery run archives prior unapproved topics. Approved work and ready scripts remain visible.

## Free Reel renderer

`VIDEO_MODE=free pnpm reel:free -- --url "https://huggingface.co/blog/grabette"` creates a source-grounded Persian 9:16 MP4 in `output/<slug>/`. It only fetches publicly available media referenced by the article and renders with FFmpeg; it never invokes a paid video-generation API. By default it uses local `espeak-ng` when available, otherwise macOS `say` as a zero-install fallback. Set `FREE_TTS_PROVIDER=espeak-ng` after installing that free local tool for the better Persian voice path.

## Gemini adapters

Set `GEMINI_API_KEY`, `GEMINI_IMAGE_MODEL`, and `GEMINI_OMNI_MODEL` in `.env`. The API exposes `GET /api/gemini/status`, `POST /api/gemini/image` with `{ "prompt": "..." }`, and `POST /api/gemini/omni` with a prompt, optional base64 `inputMedia`, and optional `responseModalities` (`TEXT`, `IMAGE`, or `AUDIO`). `GEMINI_API_BASE_URL` can point to the official API or a compatible regional gateway.

To route only Gemini traffic through an HTTP(S) proxy, set `GEMINI_PROXY_URL=http://localhost:7890`. Authenticated URLs are supported. If it is absent, the adapter checks `HTTPS_PROXY` and then `HTTP_PROXY`; no other application traffic is changed.

## Episode pipeline (topic → ready-to-publish Reel)

After the topic is agreed, write `episodes/<slug>/brief.json` (title, Persian narration, 9:16 shot prompts, caption, hashtags, `coverAt`; see `tools/episode/brief.ts`), then:

```bash
pnpm episode <slug>
```

Steps, each resumable with `--from <step>` / `--until <step>` (`shots`, `voice`, `edit`, `cover`, `qa`, `upload`); everything is written to `output/episodes/<slug>/`:

1. **shots**: Google Flow in your own Chrome (account `/u/1/`, then `/u/0/`; Veo 3.1 Lite by default, 10 credits per 8 s shot, or `"flowModel": "omni-1.2-flash"`), then the Veo API, then Higgsfield. A shot already on disk, or already finished in the episode's Flow project, is reused without spending credits.
2. **voice**: Gemini 3.8 TTS (Kore, Charon) → ElevenLabs v3 → local Piper. Each take is transcribed back and rejected above 8 % read error, then fitted to the edit (max 1.35×).
3. **edit**: 1080×1920 edit, narration over the shots' own sound, Persian captions timed to the narration, fiction label.
4. **cover**: a frame of the edit with the episode badge and title inside the 3:4 profile-grid area.
5. **qa**: size, length, audio, non-blank cover, narration clarity in the final mix, caption/hashtag limits, `contact-sheet.jpg`.
6. **upload**: Drive folder `ywa` via rclone (`YWA_NN_<Slug>_FA.mp4` + cover), public links checked, `post.json` written.

Publishing is not a step: Claude shows `post.json` and publishes to `@ywa_ai` only after your yes.

Every item published on Instagram `@ywa_ai` must also be published on the **You walk alone** YouTube channel (`UCt4vvTwH1BzVn-otS4suXDg`). Instagram approval covers publishing the same content to YouTube as well. Publishing is complete only after both platforms confirm success; YouTube failures or daily upload limits leave the item pending for retry. See [ROADMAP.md](ROADMAP.md) for the cross-platform publishing requirement, automation work, and migration backlog.

**Before a run:** Chrome must have remote debugging on (`chrome://inspect/#remote-debugging`; it resets when Chrome restarts, and Chrome may ask you to allow the connection), and the xray proxy must be up on `127.0.0.1:7890` (Google, ElevenLabs and Higgsfield are reached through it). Keys go in `.env` (see `.env.example`).

Voice tools: `pnpm voice:test` renders a sample with every TTS provider, `pnpm voice:rank` ranks them by transcription accuracy and a side-by-side audio judgement.
