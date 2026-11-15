# The Journal

One page per day: the day as Orb saw it, and your notes. Open the **Journal** tab and step through days with ‹ › or the date.

## The day's log (automatic)

Orb puts it together from everything it can read:

| Section | From |
| --- | --- |
| Alerts (today only) | Coinpile alerts, Uptime Kuma monitors that are down, changes waiting to sync, a failed stock-research run |
| Calendar | Every calendar Orb shows (CalDAV, the family calendar, Orb's own) |
| Done | Tasks ticked off that day (by you, Golem or an agent), chores done |
| Log | Orb's log entries for the day, including commits it logged for linked projects |
| Code | UpstreamManager: commits made that day on every repo it watches, requests raised or decided |
| Agents | Hermes Studio chats working on Orb tasks and projects that moved that day, their status, and the agent's latest message (how it went, what's next) |
| Omi | Omi's recap of the day (headline, decisions, open questions, highlights), that day's conversations, and Omi's action items |
| Stock picks | The picks you agreed to or passed on that day |
| Money | What you spent and earned that day, with the transactions |

Today's log is worked out live (every five minutes while the tab is open).
Shortly after midnight Orb saves yesterday's log into the journal, so a past
day keeps saying what happened even after tasks, chats and alerts move on.
**Refresh** works it out again.

### Money per day

Spent is withdrawals, income is deposits; transfers between your own
accounts count as neither. Orb reads the day's transactions from **Firefly
III** (the same ledger Coinpile uses). If Coinpile shares a `daily` list in
its Orb summary (`[{date, spent, income}]`, totals only), Orb uses those
totals, and without Firefly III shows them on their own. The Coinpile you run
today doesn't share it yet; it is a small addition there (a `daily` option
next to `spending` under Settings → Home Assistant & API).

## Notes

Type with a keyboard. Markdown works; **Read** shows it formatted. It saves
as you type.

## Handwritten notes (BOOX or paper)

Journal → **Handwritten notes** → **Photo, scan or BOOX export**:

- **From the BOOX:** export the note as **PDF** or **PNG** (each PDF page
  becomes one page here), or as **TXT** if the BOOX already recognised the
  handwriting (that text goes straight in, no reading needed).
- **From paper:** take a photo (on a phone the button offers the camera).

A vision model on your own endpoint reads each page (Settings → Journal; empty
means Golem's endpoint and model, which then must accept images, e.g.
Qwen2.5-VL, Llama 3.2 Vision or MiniCPM-V). You check the text, fix what it
got wrong, and **Add to notes** puts it in the day's notes under "Handwritten
(time)".

**Fixing a page later.** Pages you've added are listed under "Added on this
day" with their image. **Edit text** changes the page's text: the day's notes
get the new text in place of the old (if you haven't reworded it there
yourself), and the training copy is updated. **Model's reading** starts again
from what the model read.

**Learning your handwriting.** Every page you add is kept with its text in
`data/handwriting/`: the image, what the model read (`<id>.ocr.txt`), what you
corrected it to (`<id>.txt`), and one line per page in `manifest.jsonl`
(`{"image", "text", "ocr", "day", "model"}`), the usual shape for training a
handwriting model (for example fine-tuning TrOCR or a small vision model).
Until then, the words you correct most often are passed to the model as hints
on every new page. Back the folder up with the rest of `data/`.

## In the wiki

**Send this day to the wiki** writes the day into LLMWIKI's short-term
memory: the `## Journal` section of that day's daily note,
`daily/YYYY-MM-DD.md` (created from the DAILY template if needed). It holds
your notes (typed and handwritten), then the day's log in short (money, done,
log, code, agents, Omi, calendar). Orb owns that section and rewrites it whole;
the rest of the note (what agents logged) is left alone. The vault's Rollover
workflow later files the whole day into the wiki.

A past day whose daily note was already rolled over is sent once as a new
source, `raw/sources/YYYY-MM-DD - Journal.md` (`status: unprocessed`), for the
vault's Ingest workflow; Orb never changes a source after that. Tick **every
day** (or Settings → Journal) to send each finished day once, after midnight.

## Who can change it

Only you, signed in. Agents can't write the journal, and the saved day log
can't be changed through the API. Golem can read it with `journal_day`.
