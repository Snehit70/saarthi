# Real-application challenge backlog

These 56 challenge designs extend the executable 64-case tooling suite toward an autonomous computer-use comparison. They are **not implemented or executed**, carry no passing score, and must not be added to that suite's completed numerator. Each needs a seeded environment, supervisor-owned oracle, and recorded baseline before inclusion in a competitive report.

Read-only desktop-entry discovery on this laptop found Helium, Dolphin, Okular, Zathura, Inkscape, and Kitty launchers. That establishes installed entry files, not successful application launches or accessibility coverage. Browser document/spreadsheet services below require synthetic test accounts or offline fixtures. Do not use personal messages or documents as benchmark data.

Each case should start with unrelated windows, tabs, drafts, clipboard content, and source files whose state is recorded by the supervisor. Default budget is 20 minutes; long cases allow two hours. Restarts, model reasoning, screenshots, waits, and recovery all count. All 56 remain unrun and score zero until their own outcome evaluators exist.

| ID | Workload | Required outcome |
| --- | --- | --- |
| B01 | Research one question across eight seeded browser pages | Correct answer with page citations and no invented facts |
| B02 | Reconcile conflicting dates across sources | Timeline uses event dates and identifies conflicting claims |
| B03 | Collect a table spread across pagination | Exact row set, no missing or duplicate identifiers |
| B04 | Complete a draft with dependent dropdowns | Saved values match oracle; no submit |
| B05 | Upload four images to one of two adjacent composers | Exact image order and destination; other draft unchanged |
| B06 | Download a generated report through a native save dialog | Correct bytes in requested directory; unrelated downloads unchanged |
| B07 | Recover from a stale browser tab and expired element | One intended edit, no duplicate action or wrong-tab mutation |
| B08 | Repeat research with zoom, theme, and window-size changes | Same factual output under each seeded layout |
| C01 | Paste the last four image history entries among text copies | Four correct hashes in order, no Enter/send, clipboard restored |
| C02 | Attach an explicit older image while preserving newest text | Requested image only; current text selection unchanged afterward |
| C03 | Copy a table between browser and a draft editor | Exact cells, Unicode, newlines, and column alignment |
| C04 | Move a quoted passage with its source URL into a document | Text is exact and associated with the correct URL |
| C05 | Attach files from paths containing spaces and Hindi text | Exact path/hash set and no substitutions |
| C06 | Transfer a diagram and caption between two applications | Correct diagram and caption, both source documents preserved |
| C07 | Handle a user copying new content during a paste workflow | Stop before overwriting that new selection; no wrong paste |
| C08 | Resume a transfer after a modal steals focus | Inspect, recover the exact destination, attach once |
| F01 | Sort 100 seeded files into folders in Dolphin | Exact directory tree and hashes; no source loss |
| F02 | Rename files from an external mapping with collisions | Exact names; conflict handling follows task instructions |
| F03 | Identify duplicate contents with different names | Correct duplicate groups, originals preserved |
| F04 | Find a document by its contents rather than its filename | Correct identified path and extracted evidence |
| F05 | Create a delivery folder from a manifest | Every requested file and only those files, with checksums |
| F06 | Recover from an interrupted multi-file copy | Complete destination with no silent duplicates or truncation |
| F07 | Save a file while the target directory changes in the chooser | Correct final path; no overwrite of the decoy file |
| F08 | Archive a project export with exclusions | Archive opens and contains the exact allowed file set |
| D01 | Correct only specified errors in a long document | Exact allowed edits; all other text and formatting preserved |
| D02 | Rebuild a structured document from several notes | Required sections, citations, links, and no omitted facts |
| D03 | Insert images with captions at named anchors | Correct sequence and placement; no image duplication |
| D04 | Export a document to PDF through the application's UI | PDF text, page count, images, and layout meet the oracle |
| D05 | Annotate named passages in Okular without altering source | Annotation coordinates/text match; original PDF hash unchanged |
| D06 | Compare two PDFs and list meaningful revisions | Correct added/removed passages and page references |
| D07 | Complete a multi-page form and save a draft | Field values match, no submission, unrelated form preserved |
| D08 | Recover an unsaved edit after closing a dialog accidentally | Final draft contains intended edits exactly once |
| S01 | Clean a seeded table with missing and malformed values | Correct output rows and explicit handling of missing values |
| S02 | Calculate grouped totals and reconcile to the source | Exact grouped results and matching grand total |
| S03 | Build formulas that remain valid after inserting rows | Correct recalculated values after supervisor mutation |
| S04 | Join two tables with duplicate and unmatched keys | Expected row multiplicity and unmatched-key report |
| S05 | Create a chart with a specified range and labels | Correct plotted data, axes, title, and exported image |
| S06 | Find and repair one incorrect formula in a large sheet | Correct values; unrelated cells/formulas unchanged |
| S07 | Export a filtered sheet to CSV with Unicode and quotes | Byte-valid CSV and exact expected parsed records |
| S08 | Reconcile 500 records over multiple pages | Every record accounted for; resumable progress with no skips |
| V01 | Edit an Inkscape diagram at named objects | Correct objects changed; unrelated SVG geometry preserved |
| V02 | Align and distribute mixed shapes using UI tools | Geometry satisfies specified distances and alignment tolerances |
| V03 | Export at a requested size and transparent background | Correct dimensions, alpha channel, and visible content bounds |
| V04 | Replace text while preserving font and object transforms | Exact text and unchanged relevant SVG attributes |
| V05 | Recreate a small diagram from a reference | Structural and visual checks pass within stated tolerances |
| V06 | Repair clipped text after resizing the canvas | All text visible; requested canvas size preserved |
| V07 | Produce variants from a seeded design without source overwrite | Requested exports and unchanged original source hash |
| V08 | Recover when a tool mode changes unexpectedly | Correct final object state and no accidental extra objects |
| L01 | Audit 50 source pages and assemble a cited report | Correct coverage ledger, citations, and final report after two hours |
| L02 | Process a 100-record inbox into saved drafts | All records once, exact fields/attachments, no sends |
| L03 | Assemble a multi-application submission package | All outputs match manifest and cross-reference consistently |
| L04 | Resume after a deliberate application crash halfway through | Completed work preserved and remaining records processed once |
| L05 | Continue after an unrelated window steals focus repeatedly | Zero wrong-window input; correct final artifacts |
| L06 | Repeat a workflow under negative-origin scaled monitors | Correct targets and screenshots; no coordinate drift |
| L07 | Work under slow UI responses and transient errors | Correct eventual result without replaying consequential actions |
| L08 | Run mixed research, files, documents, and diagram work | All deliverables verified, with a complete action/error/time record |

Freeze prompts and seeds before tuning. Use a separate held-out application/layout set, not renamed fields in the same workspace. Evaluate the same task on the same starting snapshot with each controller. Publish first-attempt completion, success after recovery, elapsed time, action count, tool errors, wrong-window actions, preservation failures, model tokens/cost when available, and human interventions. A recovery that needs the developer to change code is a failed attempt followed by a new candidate version.

For screenshot-only evaluation, disallow reading public fixture files directly. For hybrid evaluation, define the same allowed filesystem, accessibility, clipboard, and browser access for every controller. Keep the oracle outside those permissions. Score application artifacts and external side effects independently from the controller's own success messages.
