Acknowledgements
================

Faceclaw is an open source project, at https://github.com/jimrandomh/faceclaw.
Contributors include:
    James Babcock <jimrandomh@gmail.com>
    Kalani Helekunihi <i@am.guru>


Many thanks to g2-kit-unofficial: https://github.com/Commute773/g2-kit-unofficial/,
evenRealities-openCFW https://github.com/kalanihelekunihi/evenRealities-openCFW/,
and others who contributed to documenting the G2's bluetooth protocol and firmware.

G2 microphone LC3 decoding uses Google's liblc3: https://github.com/google/liblc3

Even G1 support builds on ScouterKit (MIT License), by the ScouterKit authors:
https://github.com/mafik/scouter_kit. The firmware Faceclaw installs on a G1 is a
modified build of its g1v0, using the Zephyr RTOS and Nordic's nRF Connect SDK; the
parts of it that are Even Realities' own are downloaded from Even, not shipped here.

RayNeo iO support builds on the Glassly SDK and custom firmware by Tetramo, Inc.
and Mentra Labs, Inc. (MIT License): https://github.com/tetramo-labs/glassly and
https://github.com/tetramo-labs/glassly-rayneo-cfw. The iO wire codecs in
native/kotlin/shared/.../rayneo/RayNeoIoProtocol.kt follow their protocol work.

iPhone notification icons are Pebble's notification and timeline icons, from
https://github.com/pebble-dev/iconography: the original Pebble Technology icons
and Rebble community additions. They are licensed under the Apache License 2.0;
see app/graphics/pebble-icons.LICENSE. Faceclaw's table of the iPhone apps they
stand for builds on the one in the PebbleOS firmware,
https://github.com/coredevices/PebbleOS (also Apache License 2.0).

Weather data outside the US is by Open-Meteo.com: https://open-meteo.com/. It is
licensed under CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/).

The Terminus font is by Dimitar Zhekov's Terminus: https://framagit.org/ohnonot/terv-terc
and is distributed under the SIL Open Font License; see app/fonts/terminus/LICENSE.

The TerminusV proportional font is by ohnonot, derived from Terminus:
https://framagit.org/ohnonot/terv-terc. It is also distributed under the SIL
Open Font License; see app/fonts/terminusv/LICENSE.

The CJK font is Source Han Sans SC Light by Adobe:
https://github.com/adobe-fonts/source-han-sans. It is distributed under the SIL
Open Font License, Version 1.1; see app/fonts/source-han-sans/LICENSE.txt.
Faceclaw includes the G2's serialized 20 px LVGL build of the font so
phone-side rendering matches the glasses.

The Doto font is by the Doto project: https://github.com/oliverlalan/Doto,
distributed through Google Fonts (https://fonts.google.com/specimen/Doto).
Faceclaw includes a static Black instance (weight 900, roundness 0) built from
the upstream variable font, under app/fonts/Doto-Black.ttf. It is distributed
under the SIL Open Font License, Version 1.1; see app/fonts/OFL-Doto.txt.

The Geist and Geist Mono fonts are by Vercel, in collaboration with
basement.studio: https://github.com/vercel/geist-font. They are distributed
under the SIL Open Font License, Version 1.1; see app/fonts/OFL-Geist.txt.

The Space Grotesk font is by Florian Karsten:
https://github.com/floriankarsten/space-grotesk, distributed through Google
Fonts (https://fonts.google.com/specimen/Space+Grotesk). Faceclaw includes
static Regular, Medium, SemiBold and Bold instances (weights 400, 500, 600 and
700) built from the upstream variable font, under
app/fonts/SpaceGrotesk-Regular.ttf, app/fonts/SpaceGrotesk-Medium.ttf,
app/fonts/SpaceGrotesk-SemiBold.ttf and app/fonts/SpaceGrotesk-Bold.ttf. It is
distributed under the SIL Open Font License, Version 1.1; see
app/fonts/OFL-SpaceGrotesk.txt.

The Phosphor icon set is by Phosphor Icons:
https://github.com/phosphor-icons/core. It is distributed under the MIT
License.

The Herdr ram and terminal-prompt app icon is from the Herdr project:
https://github.com/herdrdev/herdr-app (assets/icons/herdr-ui-icon-clean.svg).
It is distributed under the Apache License, Version 2.0. The ram path in
app/graphics/icons.ts is a transformed copy of that vector, kept as one filled
path for Faceclaw's monochrome icon renderer.

Herdr's permission/question menu grammar (app/apps/herdr/prompt.ts) and the
table and tool-box render transforms (app/apps/herdr/render.ts) are adapted from
pawaca/even-better: https://github.com/pawaca/even-better. It is distributed
under the MIT License.
