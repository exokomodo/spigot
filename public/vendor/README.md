# Vendored assets

Third-party files committed to the repo rather than fetched at build or run
time. Served read-only from `/vendor` by `express.static`.

## htmx.min.js

- Version: 2.0.4
- Source: `https://unpkg.com/htmx.org@2.0.4/dist/htmx.min.js`
- SHA-384 of the committed file:

```text
1c67f3b687e8b5fb21705efef27e382502f6a099a8c150a13d3838f12fa3bd9a33b4f7efc03efd382fcb4ed1ba74ca7e
```

It is committed instead of loaded from a CDN so the page keeps working without
a third party being reachable, so the deployed bytes are the reviewed bytes,
and so a CDN compromise is not a route into a page that renders user-supplied
feed titles.

To upgrade: download the new version, update the version, URL and digest above,
then re-run the tests.
