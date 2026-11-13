# The Journal

One page per day: the day as Orb saw it, your notes, and pages to write or
draw on. Open the **Journal** tab and step through days with ‹ › or the date.

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

## Pages: writing and drawing

- **New page** starts a blank page (the shape of a BOOX Note Air page).
- **Bring in an image or PDF** (or drop files on the panel): each image
  becomes a page, and each PDF page becomes a page (up to 40), so you can
  export a note from your BOOX as a PDF or PNG and keep writing on it here.
- Pen, highlighter and eraser; five colours; three widths; Undo and Redo.
- **Full screen** fills the screen with one page and its tools; ‹ › move
  between pages.
- **Save as PNG** downloads the page with everything drawn on it.

On a tablet, the pen's pressure sets the line width. Once Orb sees a pen it
turns on **Pen only**, so a palm resting on the screen draws nothing (turn
it off to draw with a finger). A drawing pad (Wacom and the like) works too.

Strokes are kept as lines, not pictures, so they stay sharp and can be erased
or undone later. Imported images are kept in `data/journal/` (back it up with
the rest of `data/`).

## Who can change it

Only you, signed in. Agents can't write the journal, and the saved day log
can't be changed through the API. Golem can read it with `journal_day`.
