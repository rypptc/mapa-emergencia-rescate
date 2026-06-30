import type { Metadata } from "next";
import { Shell } from "../shell";
import { HubCredentialsAdmin } from "@/src/contexts/hub-credentials/hub-credentials-admin";

export const metadata: Metadata = {
  robots: { index: false },
};

export default function Page() {
  return (
    <Shell>
      <HubCredentialsAdmin />
    </Shell>
  );
}
