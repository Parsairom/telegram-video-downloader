# Adding a website adapter

yt-dlp is the universal engine (1000+ sites). An *adapter* only adds behaviour that is specific to a site or URL class on top of it —
the rest of the pipeline (format listing, selection, merge, validation, thumbnails, delivery) stays the same.

`apps/media-container/app/source_registry.py` defines the interface:

```python
class SourceAdapter(Protocol):
    name: str
    def matches(self, url: str) -> bool: ...
    def customize_request(self, request: dict) -> dict: ...      # extra yt-dlp options for this URL
    async def enrich(self, result: dict, http_get_head) -> dict: ...  # post-process the inspect result
```

The first registered adapter that `matches` wins; `YtDlpAdapter` always matches and is the fallback. Built in: `DirectMediaAdapter`
(bare `.mp4/.webm/.mkv/.m3u8/.mpd/.mp3 …` URLs — fills in the file size with a HEAD request that goes through the policy proxy).

## Steps

1. Create the adapter, e.g. in `app/adapters/example.py`:

   ```python
   from app.source_registry import YtDlpAdapter, registry

   class ExampleCdnAdapter(YtDlpAdapter):
       name = "example-cdn"

       def matches(self, url: str) -> bool:
           return "cdn.example.com" in url

       def customize_request(self, request: dict) -> dict:
           return {**request, "referer": "https://example.com/"}   # forwarded to the yt-dlp subprocess options

   registry.register(ExampleCdnAdapter())
   ```
2. Import the module once at start-up (e.g. from `app/api.py`).
3. If yt-dlp needs an option the subprocess does not yet forward, add it in `ytdlp_worker.base_options()` (read from the request dict).
4. Add tests in `apps/media-container/tests/` (see `test_unit_pure.py::test_registry_picks_first_matching_adapter_and_falls_back`)
   and, for a real site, an opt-in network test marked `@pytest.mark.network`.
5. Network access is always mediated by the policy proxy; do not open sockets yourself in an adapter. Never log URLs with tokens.

An adapter must not bypass DRM, logins, CAPTCHAs or bot checks, and must not ask users for credentials.
