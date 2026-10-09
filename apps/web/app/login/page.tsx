import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { redirect } from 'next/navigation';
import { Button, Field, Flash, Panel, inputClass } from '@/components/ui';
import { currentActor } from '@/lib/session';
import { devAuthEnabled, env } from '@/lib/env';
import { devSignIn, passwordSignIn } from '../actions';

type DevUser = { authUserId: string; name: string; role: string };

async function devUsers(): Promise<DevUser[]> {
  try {
    return JSON.parse(await readFile(process.env.DEV_USERS_FILE ?? path.join(process.cwd(), '.dev-users.json'), 'utf8')) as DevUser[];
  } catch {
    return [];
  }
}

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  if (await currentActor()) redirect('/operations');
  const { error } = await searchParams;
  const e = env();
  const supabase = !!(e.SUPABASE_URL && e.SUPABASE_PUBLISHABLE_KEY);
  const dev = devAuthEnabled();
  const users = dev ? await devUsers() : [];
  return (
    <div className="mx-auto flex max-w-md flex-col gap-4 pt-10">
      <h1 className="text-xl font-semibold">Sign In</h1>
      <Flash error={error} />
      {supabase ? (
        <Panel title="Staff Sign-In">
          <form action={passwordSignIn} className="flex flex-col gap-3">
            <Field label="Email" htmlFor="email">
              <input id="email" name="email" type="email" autoComplete="username" spellCheck={false} required className={inputClass} />
            </Field>
            <Field label="Password" htmlFor="password">
              <input id="password" name="password" type="password" autoComplete="current-password" required className={inputClass} />
            </Field>
            <Button variant="primary" type="submit">
              Sign In
            </Button>
          </form>
        </Panel>
      ) : null}
      {dev ? (
        <Panel title="Development Sign-In (Synthetic Staff)">
          {users.length ? (
            <form action={devSignIn} className="flex flex-col gap-3">
              <Field label="Synthetic staff member" htmlFor="authUserId" hint="Only available when APP_ENV is development or test and DEV_AUTH=true.">
                <select id="authUserId" name="authUserId" className={inputClass} required>
                  {users.map((u) => (
                    <option key={u.authUserId} value={u.authUserId}>
                      {u.name} ({u.role})
                    </option>
                  ))}
                </select>
              </Field>
              <Button variant="primary" type="submit">
                Continue
              </Button>
            </form>
          ) : (
            <p className="text-sm text-ink-muted">
              No synthetic users found. Run <code className="font-mono">pnpm db:seed</code> first.
            </p>
          )}
        </Panel>
      ) : null}
      {!supabase && !dev ? <p className="text-sm text-bad">No sign-in method is configured. Set Supabase Auth variables (see .env.example).</p> : null}
    </div>
  );
}
