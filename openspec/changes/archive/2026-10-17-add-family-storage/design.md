# Design

See `docs/decisions/0007-files-and-photos.md`. The personal space is derived from the session (never from the request); paths are validated per component and again with `realpath` so junctions cannot escape; uploads stream into a hidden temp file and are renamed only when complete; on early rejection the request is unpiped and drained (not destroyed) so the client receives the explanation, and the connection closes afterwards; thumbnails are made by the uploading browser so the server never decodes images.
