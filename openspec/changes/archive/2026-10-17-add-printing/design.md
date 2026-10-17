# Design

See `docs/decisions/0009-printing.md`. The printer address is configuration, never request data; ipps keeps family documents encrypted on the LAN; the server never opens the document — only the printer parses it; documents are streamed chunked; printer status is a stale-while-revalidate cache refreshed every 30 s.
