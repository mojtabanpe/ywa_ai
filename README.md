# ywa_ai

Daily Persian AI Reel discovery MVP. The current source is an RSS provider; its interface supports future Reddit, YouTube, and browser-backed Instagram providers.

## Run locally

1. `docker compose up -d`
2. `npx prisma migrate dev --name init`
3. In separate terminals: `npx nx serve api` and `npx nx serve admin`
4. Open `http://localhost:4200`, then choose **اجرای Discovery**.

API: `POST /api/discovery/runs`, `GET /api/discovery/runs`, `GET /api/discovery/topics`.

Topics are scored through a selectable LLM provider. Use `LLM_PROVIDER=gateway` with `LLM_API_BASE_URL`, `LLM_API_KEY`, and `LLM_MODEL` for the supplied gateway; use `LLM_PROVIDER=openai` with `OPENAI_API_KEY` and optional `OPENAI_MODEL` (default: `gpt-5-mini`) for OpenAI. If scoring is unavailable or its output is invalid, discovery uses a deterministic fallback score so the run still completes.

Each new Discovery run archives prior unapproved topics. Approved work and ready scripts remain visible.

## Free Reel renderer

`VIDEO_MODE=free npm run reel:free -- --url "https://huggingface.co/blog/grabette"` creates a source-grounded Persian 9:16 MP4 in `output/<slug>/`. It only fetches publicly available media referenced by the article and renders with FFmpeg; it never invokes a paid video-generation API. By default it uses local `espeak-ng` when available, otherwise macOS `say` as a zero-install fallback. Set `FREE_TTS_PROVIDER=espeak-ng` after installing that free local tool for the better Persian voice path.
