# mend — one patch tool for every AI edit format

[![hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![Rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/gmxbtt/hidden-spec-cli-01-run-20261122-v2/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![Reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/gmxbtt/hidden-spec-cli-01-run-20261122-v2/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)

AI models write edits in four shapes — unified diffs with wrong line numbers,
SEARCH/REPLACE blocks, V4A patches, and text-editor tool calls as JSON. `mend`
reads any of the four, finds the lines each edit names even when the model
drifted their whitespace or indentation, and changes every file or none.

## Usage

```sh
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

- `PATCH` is a patch file. Without it, or with `-`, `mend` reads standard input.
- `--format` is one of `auto` (the default), `unified`, `search-replace`, `v4a`,
  or `json`. With `auto`, the format is guessed from the first lines of the
  patch: a `*** Begin Patch` line means V4A, a leading `[` or `{` means JSON,
  a `<<<<<<< SEARCH` line means SEARCH/REPLACE, a `diff --git` line or a
  `--- ` line followed by a `+++ ` line means unified diff. When nothing is
  recognisable, `mend` exits 2 with `error: format`.
- `--check` reports what would change and changes nothing.
- `--strict` matches lines exactly only; without it, a line that is not found
  exactly is matched again ignoring trailing spaces and tabs, then ignoring
  leading and trailing spaces and tabs.

## Exit codes and output

- `0` — every edit applied (or, with `--check`, would apply). One line per
  file changed, then `ok: <n> file(s)`. Changed files are listed as `A` for
  added, `D` for deleted, `M` for modified, and `R <old> -> <new>` for a file
  that was moved. The list is sorted by the path in byte order, so a move is
  listed once, as `R`, in place of the `D` and `A` lines for its two paths.
- `1` — at least one edit failed. One `error: <code> <path>` line per failed
  edit, then `failed: <n> of <m> edits`. Nothing is written: a failing edit
  leaves its files untouched, and a failed edit in a patch leaves the files
  the earlier edits touched untouched too.
- `2` — the run itself was refused: bad usage, an unreadable patch file, an
  unrecognised format, or a patch that cannot be parsed. One line is printed,
  for example `error: parse 7` (a parse fault on line 7 of the patch).

## Failure codes

| Code | Meaning |
| ---- | ------- |
| `unsafe` | the path would escape the working tree (absolute, a backslash, or a `.` or `..` segment) |
| `missing` | the file an edit needs does not exist |
| `exists` | an edit would create or move onto a file that already exists |
| `no-match` | the old lines are not in the file at any matching tier |
| `ambiguous` | the old lines occur more than once at the first matching tier |


## How matching works

A line is matched at tier 0 when it is byte-for-byte identical, at tier 1
when it matches with trailing spaces and tabs stripped from both sides, and
at tier 2 when it matches with leading and trailing spaces and tabs stripped.
The first tier with at least one occurrence wins, and the occurrence nearest
the line number the patch names wins (ties go to the earlier occurrence).
With `--strict`, only tier 0 is used.

A block of old lines must occur at one tier exactly once for SEARCH/REPLACE
and for JSON `str_replace` — more than one occurrence is `ambiguous`. A
unified hunk or a V4A chunk takes the first occurrence at the first tier that
has one, searching from the anchor line or the cursor onward for V4A.

When a match is found at tier 2, the lines the patch adds are re-indented:
the leading spaces and tabs of the first old line are replaced by the leading
spaces and tabs of the file's first matched line. Context lines are always
written as the file's own matched lines, never as the patch spells them, so
an edit never dirties the whitespace of lines it does not change.

## The four formats

- **Unified diff** — `diff --git a/<x> b/<y>` headers, `--- ` / `+++ ` paths
  (a `rename from` / `rename to` pair stands in when there is no path pair),
  `new file mode` for creation, `deleted file mode` for deletion, and
  `@@ -A[,B] +C[,D] @@` hunks whose body lines are ` ` (context), `-` (old),
  `+` (new), or `\` (the previous line has no newline at end of file). An
  empty body line counts as an empty context line. A hunk with no old lines
  inserts after the named line number. A file created by a diff gets LF line
  endings; an edited file keeps the line ending it already had.
- **SEARCH/REPLACE** — a block is a path line, `<<<<<<< SEARCH`, the old
  lines, `=======`, the new lines, `>>>>>>> REPLACE`. The path is the nearest
  non-blank line before `<<<<<<< SEARCH`, after the previous block's
  `>>>>>>> REPLACE`, that does not start with three backticks; a block with
  no path line reuses the previous block's path. An empty old section creates
  the file.
- **V4A** — the first non-blank line is `*** Begin Patch` and the last
  non-blank line is `*** End Patch`. Sections start with `*** Add File: `,
  `*** Delete File: `, or `*** Update File: `. An Add section holds lines
  starting with `+` (or blank lines); a Delete section holds nothing; an
  Update section holds chunks starting at an `@@` anchor line (or, for the
  first chunk only, at a body line), each chunk ending at `*** End of File`
  when it is anchored at the end of the file. An Update section may start
  with `*** Move to: <path>` to move the file. An update with no chunk and
  no `*** Move to: ` is a parse error.
- **JSON** — one JSON array of edit objects, or JSON Lines with one edit
  object per line. Each object names a `path` and a `command`: `create`
  (with `file_text`), `str_replace` (with `old_str` and `new_str`), or
  `insert` (with `insert_line`, 0-based, and `new_str`). `str_replace` and
  `insert` keep the file's CRLF or LF endings, and `str_replace` accepts
  `old_str` and `new_str` written with either line ending.

## Safety and atomicity

- No path may escape the working tree: absolute paths, backslashes, and `.`
  or `..` segments are refused with `error: unsafe <path>`.
- A patch that yields no edits is refused with `error: parse 1`.
- Every edit is applied to a tree in memory first. If any edit fails, no file
  is written at all; if several edits in one patch touch the same file, the
  later edits see the earlier ones' results.
- A file that is written keeps its own line endings (LF or CRLF, as read from
  the first line feed) and its final newline unless an edit touches the end of
  the file. A newly created file ends with a newline unless the patch says
  otherwise.

## Development

`node main.ts` needs Node 22 and nothing else — no dependencies. Run the
practice set with `node check.ts <practice.json>` (the kit's checker) from
this directory, or run the smoke tests by hand:

```sh
printf '*** Begin Patch\n*** Add File: hello.txt\n+hello\n*** End Patch\n' | node main.ts -
node main.ts --check patch.diff
```

SPDX-License-Identifier: MIT
