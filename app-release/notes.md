**Installing over 1.1.21 or older: remove the old app first, once.** This version is signed with a new key, so
Android won't install it on top of an older copy ("App not installed"). Uninstall Touchless Bridge, install
1.1.22, then connect the phone and sign in to HackerAI again. Later versions update in place as before.

A new look, an easier start, a new icon, and the app now shows when HackerAI is working.

- **You can see HackerAI working.** While HackerAI works in the chat, the app's icon in the status bar moves, and
  the notification says "HackerAI is working" with the step it is on right now ("Thinking...", "Opening Maps",
  "Phone tool: get battery status", "Running a command: nmap") and a running clock. Opened, it lists the last few
  steps. Home shows the same line. It keeps following after you close the chat window, and goes quiet when
  HackerAI is done. Only a short line per step is shown, never a command's arguments or its output.
- **The chat stays where you left it.** Closing the chat window no longer throws the page away: open it again and
  it is there at once, also in the middle of a task. A chat left idle for 10 minutes is let go and loads fresh.
- **`touchless … --say "…"` and `--done` work on the phone too** (when the phone itself is the HackerAI machine),
  as they do on a computer. The setup prompt now shows the real form: `touchless call <tool> key=value`.
- **New icon.** A hooded figure whose face is a terminal prompt (`>_`). It also has a themed-icon version, and the
  "Running" notification uses it.
- **Home shows where you stand.** A status card with the phone, Touchless and HackerAI as three points on a line.
  When the phone is connected a glowing packet travels from it to Touchless, and on to HackerAI once you're signed
  in there; while the phone isn't connected nothing moves. A button takes you to HackerAI.
- **The animation shows on every phone**, also where the phone's own animations are turned off. Settings › about ›
  "Animate the status" turns it off.
- **One thing to do on Home: connect your phone.** With a Paste button, and "Open Touchless", which opens the
  Touchless app to copy your address. Once the phone is connected the card folds away and HackerAI opens by itself.
- **HackerAI in the middle of the bottom bar.** One tap from anywhere.
- **Settings in cards.** Connection, HackerAI, always on, about. A line that isn't connected takes you back to
  Home. Running the bridge on the phone itself is now one switch in the connection list, "Remote Control on this
  phone". The setup prompt can be sent again, not only copied.
- **"Check for updates" answers.** It says "No newer version found" when there is nothing newer.
- **Battery.** Settings shows when battery use is already unrestricted, and the button only when it isn't.
- **The chat shows a page loading** with a thin line along the top.
- **Back from Settings** returns to Home.
