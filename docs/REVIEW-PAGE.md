# Review page loop (Send to Claude)

A rendered version is reviewed on a **private claude.ai page** (the `video-review-notes` page: zoomable timeline,
frame and clip notes with type tags, phone layout), and the notes come straight back to Claude. VideoHub turns them
into its own notes, so a partial re-render redoes only what they touch. It works the same on Windows and on the RunPod
pod (docs/LINUX.md), and needs no server open to the internet: the page talks to claude.ai only.

```
render (hub_render) → hub_review_build → publish page.html (Artifact) ─┐
     ▲                                                                   ▼
partial re-render ← hub_note_update ← fix ← hub_review_import ← "Send N notes to Claude" on the page
     └→ hub_review_build (round N+1, same url) → hub_review_status → ArtifactData batch (Done + Claude's note on each)
```

## How the notes reach Claude
The page declares `comments`; its **Send to Claude** button marks the notes sent in the page's database and calls
`comments.sendToClaude`, which posts one comment listing them and **wakes every Claude session watching the page**
(the session that published it watches it automatically). A chip shows *Claude is listening* / *Claude offline*
(`canSendToClaude`). With no session open the notes stay saved and the banner says to tell Claude in the thread; the
next session reads them from the database the same way.

## Steps for Claude
1. `hub_review_build {project, title?, note?, url?}` → `<film>/.videohub/review/round-N/` with `page.html`,
   `review.mp4` (under ~14 MB: 720p when the bitrate allows), `strip.jpg`, `sections.json`. Sections come from
   `review-sections.json` in the film (`{sectionLabel, sections:[{n,start,end?,text}]}`), else the narration
   transcript, else stored scenes, else the 2-second render chunks.
2. First round: Artifact publish `page.html` with `files: {"review.mp4", "strip.jpg"}` from the result,
   `capabilities: {db:{}, assets:{}, user:{}, comments:{}}`, icon `video`. Later rounds: publish with the page's `url`
   and no `capabilities`. Pass the url to `hub_review_build` once so it is remembered.
3. On the wake (a comment sent to Claude): ArtifactData `list` the `notes` collection with `out_dir`, then
   `hub_review_import {dir}`. Only sent notes are taken; an edited one updates its VideoHub note (and reopens it if it
   was fixed). The page note id is kept in `.videohub/review/state.json`. The import lists each note's capture
   (`snapshotId`, the frame the user captured; a clip's first frame): fetch it with Artifact `read` and `path` = that
   id and look at it before fixing. The comment that wakes Claude carries text only, never the picture.
4. Fix only what each note asks; `hub_note_update` (fixed + one sentence). Render partial: by notes, or by `seconds`
   when a change must cover a whole scene (a fix in only some chunks of a scene would jump at the chunk edge).
5. `hub_review_build` again (next round, `note` = what changed), publish to the same url, then
   `hub_review_status {versions:{<pageNoteId>: <version from the list>}}` and apply its writes with one ArtifactData
   `batch`: each note shows Done with Claude's note. Reply in the comment thread (ArtifactComments) and resolve it.
6. A note that is unclear: set its page doc `status: "question"` with the question in `claudeNote`, reply in the
   thread, and wait.

Tested on a scratch copy of the example film: page in Chromium at desktop and iPhone 13 size with a mocked
`window.claude` (frame and clip notes, snapshot, Send, the offline case), then a real published page: notes imported,
fixed, the shapes scene re-rendered (3 chunks of 5), round 2 published to the same url and the note marked Done.
