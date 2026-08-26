
# Changelog

## [0.1.8] - 2026-08-26
### Added
- Trace data message now indicates if a request was aborted by the user before it was fetched.
- User aborted requests bypass any further callback handlers

### Fixed
- Aborted requests are immediately removed from the queue and rejected. Fixes unresolved aborted promises.
