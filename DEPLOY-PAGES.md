# Hosting the tools on Cloudflare Pages

The proposal tool and the submissions console only exist while
`npm run dev` is running on one laptop. This puts them on a URL,
behind a login, so Charlie can use them from his own machine.

Cloudflare Pages serves the files; Cloudflare Access sits in front
and asks who you are before anything loads. Both are free at this
size — Access is free to 50 users and this is two.

## Why not a password

Netlify and Vercel both put password protection on a paid plan, and
a shared password is the weaker thing anyway: it cannot be revoked
for one person. Access is per-person. Charlie gets a code at his own
address, and removing him is one click that does not affect you.

## One-time setup

1. **Cloudflare account.** dash.cloudflare.com, sign up free. The
   domain does not need to move — Pages gives you a
   `something.pages.dev` address.

2. **Connect the repo.** Workers & Pages → Create → Pages → Connect
   to Git → pick `tm-measure`.

3. **Build settings.**
   - Framework preset: **Next.js (Static HTML Export)**
   - Build command: `npm run build:pages`
   - Output directory: `out`

4. **Environment variables**, same values as Codemagic:
   - `NEXT_PUBLIC_MEASURE_SUBMIT_URL` — the Apps Script /exec URL
   - `NEXT_PUBLIC_ENABLE_SCAN` = `1`
   - `NEXT_PUBLIC_ENABLE_LIDAR` = `1`

5. **Deploy.** Two or three minutes. You get a URL.

## Lock it down — do this before sharing the URL

Zero Trust → Access → Applications → Add an application → Self-hosted.

- Application domain: the `.pages.dev` address
- Policy: **Allow**, rule type **Emails**, listing
  `tmarchitecturalltd@gmail.com` and Charlie's address
- Save

From then on the URL asks for an email, sends a code, and lets in
nobody else. Test it in a private window before you send it to him.

## What is behind the login

Everything, including `/measure`. That matters: the customer's
measuring flow is *in the app*, not on this site, so there is no
reason for the web copy to be public, and leaving it open would
mean the submissions console sits one guessed URL away from the
survey form on the same host.

## The admin secret still applies

Access controls who reaches the site. The Apps Script endpoint has
its own ADMIN_SECRET, which the console and the proposal tool send
with every request. Both are needed: Access stops strangers at the
door, the secret stops the backend answering anyone who has the
/exec URL.

## When the code changes

Pages rebuilds on every push to `main`, the same trigger Codemagic
uses for the app. Nothing extra to run.
