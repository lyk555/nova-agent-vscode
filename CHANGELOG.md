# Changelog

## 0.0.8

- Added unified diff support through the `apply_patch` tool
- Added a patch parser and workspace patch applier for structured edits
- Extended the local tool protocol from simple writes/replaces to precise diff-based edits

## 0.0.7

- Added structured edit tools: `write_file` and `replace_in_file`
- Added visible current-tool status in the sidebar
- Extended the local tool protocol from read-only repo inspection to simple file editing
