import "server-only";

import { read, mutate } from "../store";
import { assertUser } from "../auth";
import { hashPassword, verifyPassword } from "../crypto";

/** Update the current user's display name. */
export async function updateProfile(input: { name: string }): Promise<void> {
  const user = await assertUser();
  const name = input.name.trim();
  if (!name) throw new Error("Name is required");
  mutate((d) => {
    const u = d.users.find((x) => x.id === user.id);
    if (!u) throw new Error("User not found");
    u.name = name;
  });
}

/** Change the current user's email, after re-checking their password. */
export async function updateEmail(input: {
  email: string;
  currentPassword: string;
}): Promise<void> {
  const user = await assertUser();
  const email = input.email.toLowerCase().trim();
  if (!email.includes("@")) throw new Error("Enter a valid email address");
  const d = read();
  const me = d.users.find((x) => x.id === user.id);
  if (!me) throw new Error("User not found");
  if (!verifyPassword(input.currentPassword, me.passwordHash))
    throw new Error("Current password is incorrect");
  if (d.users.some((u) => u.id !== user.id && u.email.toLowerCase() === email))
    throw new Error("An account with this email already exists");
  mutate((data) => {
    const u = data.users.find((x) => x.id === user.id)!;
    u.email = email;
  });
}

/** Change the current user's password, after verifying the current one. */
export async function changePassword(input: {
  currentPassword: string;
  newPassword: string;
}): Promise<void> {
  const user = await assertUser();
  if (input.newPassword.length < 8)
    throw new Error("Choose a password of at least 8 characters");
  const me = read().users.find((x) => x.id === user.id);
  if (!me) throw new Error("User not found");
  if (!verifyPassword(input.currentPassword, me.passwordHash))
    throw new Error("Current password is incorrect");
  mutate((data) => {
    const u = data.users.find((x) => x.id === user.id)!;
    u.passwordHash = hashPassword(input.newPassword);
  });
}
