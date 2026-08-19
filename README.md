# UFC Kuthiradam Tournament Manager

A mobile-first football tournament manager for **UFC Kuthiradam Arts & Sports Club**.

## Features

- 10 editable teams with team images/crests.
- **No group randomization:** first 5 entered teams go to Group A; next 5 go to Group B.
- Five-matchday round robin in each group.
- Live standings with P/W/D/L/GD/PTS.
- Top two from each group qualify for the semi-finals.
- Semi-finals and final with score entry and automatic advancement.
- Champion display.
- Responsive mobile UI.
- LocalStorage cache for offline resilience.
- **Supabase shared cloud state:** the same tournament room can be opened on multiple phones.
- Supabase Realtime updates open screens when another device changes the tournament.
- Team images are compressed before being stored in the tournament state.

## Shared mode setup

See **SUPABASE_SETUP.md** for the exact SQL and configuration steps.

You must set the values in `supabase-config.js` before the cloud sharing works.

The default shared room is:

`ufc-kuthiradam-2026`

A custom room can be selected with:

`?tournament=your-room-code`

Use the website's **Copy live link** button to share the exact room URL.

## GitHub Pages

1. Create a GitHub repository.
2. Upload the contents of this folder, keeping `index.html` in the root.
3. Open **Settings → Pages**.
4. Select **Deploy from a branch**.
5. Choose `main` and `/ (root)`.
6. Save and open the generated GitHub Pages URL.

## Security note

The simple setup SQL intentionally permits anonymous read/write for easy public tournament operation. It is suitable for a trusted organizer/event board, but it is **not secure against malicious edits**. For a production event, add Supabase Authentication and restrict write policies to the organizer account while leaving public read access enabled.

Never put a Supabase service-role/secret key in the browser.
