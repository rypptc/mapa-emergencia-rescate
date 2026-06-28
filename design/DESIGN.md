---
version: alpha
name: Terremoto Venezuela
description: Sistema visual para una plataforma humanitaria de emergencia, rescate y coordinacion publica.
colors:
  primary: "#092334"
  secondary: "#2B51F0"
  tertiary: "#C41A1A"
  neutral: "#EEF2F7"
  canvas: "#EEF2F7"
  surface: "#FFFFFF"
  surface-muted: "#F7F8F9"
  surface-raised: "#FFFFFF"
  border: "#DDE3EB"
  border-strong: "#D6DBDF"
  text: "#0A1628"
  text-muted: "#4A5568"
  text-soft: "#94A3B8"
  on-dark: "#FFFFFF"
  brand-navy: "#092334"
  brand-blue: "#2B51F0"
  action-blue: "#1A98FF"
  crisis-red: "#C41A1A"
  crisis-red-hover: "#991B1B"
  rescue-red: "#DC2626"
  supplies-yellow: "#EAB308"
  shelter-green: "#16A34A"
  no-power-blue: "#0EA5E9"
  missing-purple: "#9333EA"
  building-brown: "#78350F"
  volunteer-green: "#047857"
  warning: "#FBB658"
  warning-surface: "#F8F0E0"
  success: "#10B981"
  success-surface: "#E3F5F0"
  info-surface: "#E6F3FF"
  venezuelan-yellow: "#CF9A0C"
  venezuelan-blue: "#00247D"
  venezuelan-red: "#CF0A2C"
  dark-canvas: "#0B1526"
  dark-surface: "#132236"
typography:
  display-lg:
    fontFamily: Stara
    fontSize: "48px"
    fontWeight: 700
    lineHeight: 1.1
    letterSpacing: "-0.02em"
  headline-lg:
    fontFamily: Stara
    fontSize: "36px"
    fontWeight: 700
    lineHeight: 1.12
    letterSpacing: "-0.02em"
  headline-md:
    fontFamily: Stara
    fontSize: "28px"
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: "-0.02em"
  title-md:
    fontFamily: Space Grotesk
    fontSize: "20px"
    fontWeight: 700
    lineHeight: 1.25
    letterSpacing: "0em"
  body-lg:
    fontFamily: Space Grotesk
    fontSize: "18px"
    fontWeight: 400
    lineHeight: 1.6
    letterSpacing: "0em"
  body-md:
    fontFamily: Space Grotesk
    fontSize: "16px"
    fontWeight: 400
    lineHeight: 1.45
    letterSpacing: "0em"
  body-sm:
    fontFamily: Space Grotesk
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.45
    letterSpacing: "0em"
  label-md:
    fontFamily: Space Grotesk
    fontSize: "14px"
    fontWeight: 700
    lineHeight: 1
    letterSpacing: "0em"
  label-caps:
    fontFamily: Space Grotesk
    fontSize: "12px"
    fontWeight: 700
    lineHeight: 1
    letterSpacing: "0.12em"
rounded:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "24px"
  2xl: "32px"
  pill: "999px"
spacing:
  1: "4px"
  2: "8px"
  3: "12px"
  4: "16px"
  5: "24px"
  6: "32px"
  7: "48px"
  8: "64px"
components:
  nav-bar:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    typography: "{typography.label-md}"
    height: "62px"
  hero-surface:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-dark}"
    typography: "{typography.display-lg}"
    rounded: "{rounded.xs}"
  access-card:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    typography: "{typography.body-sm}"
    rounded: "{rounded.lg}"
    padding: "20px"
  card:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    typography: "{typography.body-md}"
    rounded: "{rounded.xl}"
    padding: "24px"
  primary-button:
    backgroundColor: "{colors.tertiary}"
    textColor: "{colors.on-dark}"
    typography: "{typography.label-md}"
    rounded: "{rounded.pill}"
    padding: "14px"
  primary-button-hover:
    backgroundColor: "{colors.crisis-red-hover}"
    textColor: "{colors.on-dark}"
    typography: "{typography.label-md}"
    rounded: "{rounded.pill}"
    padding: "14px"
  secondary-button:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    typography: "{typography.label-md}"
    rounded: "{rounded.pill}"
    padding: "12px"
  volunteer-button:
    backgroundColor: "{colors.volunteer-green}"
    textColor: "{colors.on-dark}"
    typography: "{typography.label-md}"
    rounded: "{rounded.pill}"
    padding: "14px"
  global-help-button:
    backgroundColor: "{colors.secondary}"
    textColor: "{colors.on-dark}"
    typography: "{typography.label-md}"
    rounded: "{rounded.pill}"
    padding: "14px"
  input:
    backgroundColor: "{colors.surface-muted}"
    textColor: "{colors.text}"
    typography: "{typography.body-sm}"
    rounded: "{rounded.md}"
    padding: "12px"
  map-chip-active:
    backgroundColor: "{colors.text}"
    textColor: "{colors.on-dark}"
    typography: "{typography.label-md}"
    rounded: "{rounded.pill}"
    padding: "8px"
---

# DESIGN.md - Terremoto Venezuela

Este archivo sigue el formato
[DESIGN.md](https://github.com/google-labs-code/design.md/blob/main/docs/spec.md)
para que humanos y agentes compartan una fuente de verdad visual. Consolida el
sistema que ya vive en `app/globals.css` y lo alinea con el board de referencia
[Terremotovzla2026](https://www.figma.com/board/23o0xM6yOhGQ3LRexCfb2J/Terremotovzla2026?node-id=0-1&p=f).

## Overview

La interfaz debe sentirse como un centro de coordinacion en una crisis:
tranquila, clara, movil primero y orientada a decisiones rapidas. La voz visual
combina gravedad editorial con utilidad de tablero operativo. Nada debe verse
como una pieza promocional ni como una app social; cada pantalla debe ayudar a
reportar, verificar, ubicar, compartir o encontrar ayuda con el menor esfuerzo.

La marca visible es **Terremoto Venezuela**. Usa azul/navy para confianza,
rojo solo para urgencia y acciones primarias, verde para ayuda disponible, y
amarillo para suministros o advertencias. La franja superior con los colores de
Venezuela es un marcador de contexto nacional, no una decoracion libre.

## Colors

La paleta prioriza contraste, lectura en exteriores y estados de emergencia.
Los valores normativos estan en los tokens YAML.

- **Base operativa:** `canvas`, `surface`, `border`, `text` y `text-muted`
  forman la interfaz principal. Deben dominar pantallas densas como mapa,
  listas, formularios y directorios.
- **Marca y confianza:** `brand-navy`, `brand-blue` y `action-blue` se usan en
  hero, enlaces importantes, capas informativas y acciones no destructivas.
- **Urgencia:** `crisis-red` es para reportar, donar en contexto critico,
  foco visible, badges de riesgo alto y llamadas de emergencia. No lo uses para
  adornar bloques neutros.
- **Capas del mapa:** `rescue-red`, `supplies-yellow`, `shelter-green`,
  `no-power-blue`, `missing-purple` y `building-brown` identifican tipos de
  reporte. Mantener estos colores estables ayuda a reconocer capas rapidamente.
- **Contexto nacional:** `venezuelan-yellow`, `venezuelan-blue` y
  `venezuelan-red` se reservan para la banda superior y acentos de identidad.

En modo oscuro conserva la jerarquia: `dark-canvas` como fondo, `dark-surface`
como panel, texto claro y rojos/verdes suficientemente saturados para no perder
significado.

## Typography

La tipografia usa **Stara** para titulos, marca y numeros de alto impacto, y
**Space Grotesk** para cuerpo, controles, formularios y metadata. Stara aporta
presencia editorial; Space Grotesk mantiene legibilidad en tableros densos.

- **Titulares:** `display-lg`, `headline-lg` y `headline-md` deben ser breves,
  directos y legibles sobre fondos complejos. Evitar frases largas en hero.
- **Texto operativo:** `body-md` es el valor por defecto para explicaciones y
  formularios. `body-sm` cubre listas, ayuda contextual y descripciones.
- **Controles y datos:** `label-md` se usa para botones, chips y tabs. Usa
  `label-caps` con moderacion para metadata o categorias, nunca para parrafos.
- **Numeros y contadores:** mantener `tabular-nums` cuando haya conteos,
  tiempos o estadisticas que cambian en vivo.

## Layout

El layout es movil primero con un ancho maximo de **1120px** para contenido
editorial y administrativo. El mapa funciona como superficie primaria, no como
ilustracion: en desktop debe combinar mapa + sidebar; en movil debe priorizar
acciones fijas y filtros horizontales sin tapar datos importantes.

El ritmo espacial sigue una escala de 4px a 64px. Usa `spacing.2` y
`spacing.3` para chips y controles densos; `spacing.5` y `spacing.6` para
cards; `spacing.7` y `spacing.8` para separar secciones publicas.

Las secciones deben alternar superficies claras (`canvas`, `surface`,
`surface-muted`) para mejorar escaneo. Evitar bloques flotantes anidados: si ya
hay una card, sus hijos deben ser contenido o controles, no otra card completa.

## Elevation & Depth

La profundidad comunica jerarquia, no decoracion. Usa sombras suaves para cards
de ayuda, paneles de mapa, barras flotantes y modales. El hover puede levantar
una card 2-3px cuando la accion sea segura, pero no debe mover elementos en
flujos criticos de reporte si puede causar toques accidentales.

Los overlays del mapa deben usar blur/translucidez solo cuando no reduzcan la
legibilidad. En estados de "toca el mapa para ubicar el reporte", oscurece el
mapa y muestra una instruccion clara, siempre con salida visible.

## Shapes

Los radios expresan funcion:

- `rounded.sm` y `rounded.md` para campos, badges, chips pequenos y controles
  de tabla.
- `rounded.lg` y `rounded.xl` para cards publicas, filtros, paneles y bloques
  de ayuda.
- `rounded.pill` para botones principales, chips activos, acciones flotantes y
  navegacion movil.

El icono de marca usa un rectangulo rojo compacto con el simbolo de alerta.
Mantenerlo simple, sin efectos extra ni fondos fotograficos.

## Components

- **Nav bar:** fija arriba, superficie blanca, borde inferior fuerte y acciones
  compactas. Debe contener marca, ayuda psicologica, comunidad, red social,
  idioma y tema sin envolver en desktop.
- **Hero:** fondo navy con imagen real de contexto en baja opacidad. El texto
  siempre blanco, con sombra ligera. Las cuatro opciones de acceso son el
  primer flujo, no una decoracion.
- **Access card:** card blanca con emoji grande, titulo corto y descripcion
  humana. Debe soportar dos columnas en movil y cuatro en desktop.
- **Primary button:** rojo, texto blanco, radio pill. Reservado para reportar,
  donar o acciones que mueven al usuario hacia ayuda urgente.
- **Map shell:** mapa + sidebar con borde de 1.5px, radio `rounded.lg`,
  filtros horizontales y accion flotante de reportar. Las capas usan los
  colores estables de `REPORT_TYPES`.
- **Forms:** campos sobre `surface-muted`, borde visible, foco rojo y mensajes
  accionables. No ocultar fallos de guardado ni transformar errores en exito.
- **Help cards:** cards blancas de `rounded.xl`, icono en una pastilla suave,
  texto breve y accion de ancho completo.
- **Mobile sticky nav:** fija abajo, respeta safe areas y mantiene acciones
  principales accesibles con el pulgar.

## Do's and Don'ts

- **Do:** prioriza claridad, contraste, estados vacios utiles y texto en
  espanol venezolano claro.
- **Do:** usa datos sinteticos o anonimizados en ejemplos, fixtures y capturas
  de diseno.
- **Do:** conserva colores de capas y enums de reporte; los usuarios aprenden
  ese lenguaje visual durante la emergencia.
- **Don't:** publiques telefonos, correos, direcciones privadas, coordenadas
  sensibles, fotos privadas o hashes reales en piezas de diseno o docs.
- **Don't:** uses rojo para decorar ni para acciones secundarias; reduce su
  fuerza si no hay urgencia real.
- **Don't:** cambies iconos/colores de capas sin una migracion visual clara y
  comunicada.
- **Don't:** conviertas badges de aliados o verificaciones en promesas de
  seguridad estructural, aval gubernamental o confirmacion oficial.
