# UFC Kuthiradam — Supabase setup

This version keeps the existing tournament logic, but adds a shared cloud state so the same tournament can be opened on multiple phones.

## 1. Create a Supabase project

Create a project at https://supabase.com/.

Open **Project Settings → API** and copy:

- Project URL
- `anon` / publishable key

Paste them into `supabase-config.js`.

## 2. Create the shared tournament table

Open **SQL Editor** in Supabase and run:

```sql
create table if not exists public.ufc_tournaments (
  tournament_id text primary key,
  state jsonb not null,
  updated_at timestamptz not null default now()
);

alter table public.ufc_tournaments enable row level security;

create policy "public can read UFC tournaments"
on public.ufc_tournaments
for select
to anon, authenticated
using (true);

create policy "public can create UFC tournaments"
on public.ufc_tournaments
for insert
to anon, authenticated
with check (true);

create policy "public can update UFC tournaments"
on public.ufc_tournaments
for update
to anon, authenticated
using (true)
with check (true);

alter table public.ufc_tournaments replica identity full;

-- Realtime is required for instant updates between phones.
alter publication supabase_realtime add table public.ufc_tournaments;
```

## 3. Configure the website

Edit `supabase-config.js`:

```js
window.UFC_SUPABASE_CONFIG = {
  url: 'https://YOUR-PROJECT.supabase.co',
  anonKey: 'YOUR-ANON-OR-PUBLISHABLE-KEY'
};
```

The anon/publishable key is designed to be used in browser applications. **Never put a Supabase service-role key in this file.**

## 4. Deploy to GitHub Pages

Upload the contents of this folder to your GitHub repository. Keep `index.html` at the repository root.

Then:

1. GitHub → repository → **Settings**
2. **Pages**
3. Source: **Deploy from a branch**
4. Branch: `main`
5. Folder: `/ (root)`
6. Save

## 5. How sharing works

The default tournament room is:

`ufc-kuthiradam-2026`

The URL can also contain a room code:

`https://YOUR-USERNAME.github.io/YOUR-REPO/?tournament=ufc-kuthiradam-2026`

Anyone opening the same room URL reads the same cloud state.

When an organizer changes a team, draws groups, enters a result, or updates a knockout match, the change is pushed to Supabase and other open devices update automatically through Realtime. A small localStorage cache is also maintained for resilience.

## Important security note

The SQL above intentionally allows anonymous read/write so this is easy to run as a public tournament board. It is **not an admin security system**: anyone who can access the room can technically modify the data.

For a production tournament where only an organizer can change scores, add Supabase Authentication and authenticated write policies. Spectators can remain read-only.
