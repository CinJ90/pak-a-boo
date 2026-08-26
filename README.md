# Pak-a-boo

Pak-a-boo is a privacy-first Chrome extension that uses one gentle break rhythm to remind you to rest your eyes, move, and drink water.

## Development

```sh
npm install
npm run typecheck
npm run build
```

To try the unpacked extension, open `chrome://extensions`, enable Developer mode, choose **Load unpacked**, and select the `dist` folder. After source changes, run `npm run build` again and reload the extension.

The current build covers M1–M2: a unified alarm, idle-aware scheduling, popup controls (focus for 1 hour, turn reminders off indefinitely, EN/TH language switch), the full escalating-ghost interaction (peek → float out → nap on your cursor, with its own "5 more minutes" snooze on the ghost itself), and the big-break overlay with guided TH/EN stretch instructions. There are no accounts, servers, analytics, or tracking.