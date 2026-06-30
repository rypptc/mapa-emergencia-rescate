import type { Metadata } from "next";
import { Shell } from "../shell";
import { UsersAdmin } from "./users-admin";

export const metadata: Metadata = {
  robots: { index: false },
};

export default function Page() {
  return (
    <Shell>
      <UsersAdmin />
    </Shell>
  );
}
