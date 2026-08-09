"""Extension point for browser-backed discovery providers.

The Nest API owns scheduling, persistence, and scoring. This worker is purposely
small: future Instagram, YouTube or Reddit providers can use Playwright here and
POST normalized ProviderItem payloads to an internal API endpoint.
"""
from dataclasses import dataclass
from playwright.async_api import async_playwright

@dataclass
class ProviderItem:
    external_id: str
    url: str
    title: str
    description: str | None = None

class PlaywrightDiscoveryProvider:
    name: str
    async def collect(self) -> list[ProviderItem]:
        async with async_playwright() as p:
            browser = await p.chromium.launch(headless=True)
            try:
                # Provider-specific navigation and extraction belongs here.
                return []
            finally:
                await browser.close()
