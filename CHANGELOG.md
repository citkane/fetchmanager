
# Changelog

## [0.1.9] - 2026-08-27
### Added
- Test accuracy under load - 1000 requests @10,000/s max with heartbeat at the cpu clock

### Fixed
- target matching on partial string, eg "foo.com/status" now no longer matches "foo.com/statuses"
- error in LibCallback.retry.generic_factory: now correctly parses against max limits
- trace_cb now traces once after the last request was unshifted, ie. the "queue empty" event is registered

## [0.1.9] - 2026-08-27
### Added
- Improved documentation.

## [0.1.8] - 2026-08-26
### Added
- Trace data message now indicates if a request was aborted by the user before it was fetched.
- User aborted requests bypass any further callback handlers

### Fixed
- Aborted requests are immediately removed from the queue and rejected. Fixes unresolved aborted promises.
