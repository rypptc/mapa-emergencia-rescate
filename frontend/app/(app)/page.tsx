import dynamic from "next/dynamic";
import EmergencyApp from "@/components/features/emergency";
import { HeroDesktopNav, MobileStickyNav } from "@/components/layout/SectionNav";
import SiteFooter from "@/components/layout/SiteFooter";
import HeroSection from "@/components/layout/HeroSection";
import HelpSection from "@/components/layout/HelpSection";
import AlertTicker from "@/components/layout/AlertTicker";
import TutorialSteps from "@/components/layout/TutorialSteps";
import { LazySection } from "@/components/ui/LazySection";

const MissingPersonsCarousel = dynamic(
  () => import("@/components/features/missing-carousel"),
  {
    loading: () => (
      <section className="border-b border-[var(--eborder)] bg-[var(--esurf)] px-4 py-6 text-center text-sm text-[var(--etext2)]">
        Cargando directorio…
      </section>
    ),
  },
);

const EarthquakesPanel = dynamic(
  () => import("@/components/features/earthquakes"),
  {
    loading: () => (
      <section className="border-b border-[var(--eborder)] bg-[var(--ebg)] px-4 py-6 text-center text-sm text-[var(--etext2)]">
        Cargando sismos…
      </section>
    ),
  },
);

export default function Home() {
  return (
    <>
      <HeroDesktopNav />
      <main id="main" className="flex-1">
        <HeroSection />
        <AlertTicker />

        <MissingPersonsCarousel />

        <TutorialSteps />

        <HelpSection />

        {/* Mapa Leaflet + paneles con polling: pesado y below-the-fold. Lo
            diferimos hasta acercarse al viewport (rootMargin amplio = listo al
            llegar) para no cargar Leaflet/tiles en el arranque de quien no baja. */}
        <LazySection
          rootMargin="600px"
          minHeight={600}
          fallback={
            <div className="flex min-h-[600px] items-center justify-center text-sm text-[var(--etext2)]">
              Cargando mapa de emergencia…
            </div>
          }
        >
          <EmergencyApp />
        </LazySection>

        {/* Sismos: también below-the-fold; lo diferimos al acercarse. */}
        <LazySection rootMargin="400px" minHeight={240}>
          <EarthquakesPanel />
        </LazySection>
      </main >

      <SiteFooter />
      <MobileStickyNav />
    </>
  );
}
