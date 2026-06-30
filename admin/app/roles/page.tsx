import type { Metadata } from "next";
import { Shell } from "../shell";
import { RolesAdmin } from "./roles-admin";

export const metadata: Metadata = {
  robots: { index: false },
};

export default function Page() {
  return (
    <Shell>
      <RolesAdmin />
    </Shell>
  );
}
