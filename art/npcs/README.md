# Female pedestrian art and build sources

These assets define four wholly original, clearly adult Johannesburg pedestrian identities. The generated images are
modeling and textile inputs only: they are not UV maps, real-person likenesses, or substitutes for the skinned GLBs.
`manifest.json` is the build recipe and asset contract; editable Blend/FBX files are intentionally ignored.

## Selected generated outputs

- `references/*-turnaround.png`: matching-scale front, profile, rear and three-quarter identity/outfit references.
- `materials/*-source.png`: flat textile sources blended with the luminance and layout of the real MakeHuman garment UV
  textures by `tools/npc/create-source.py`.
- `previews/*-turnaround.jpg`: Blender renders of each final MPFB source from four angles.
- `previews/*-animations.jpg`: `idle`, `walk`, `sprint`, `punch_right`, and grounded `death` inspection frames.

The eight source images were generated with OpenAI's built-in image-generation tool on 14–15 July 2026. Under the
applicable OpenAI terms, the generated output is project-owned to the extent permitted by law. No third-party image,
celebrity likeness, franchise character, trademark, logo, or watermark was supplied as an input. SHA-256 digests for
every selected input and shipped output are recorded in `sources.lock.json`.

## Prompt set

### Braamfontein creative turnaround

Use case: stylized-concept. Asset type: game character production turnaround reference. Create an original, clearly
adult Black South African woman, age 27, a Braamfontein creative, as a cosmopolitan Johannesburg pedestrian NPC.
Attractive and confident, with deep warm-brown skin, athletic-average build, neat waist-length box braids tied partly
back, a fitted rust cropped jacket over a charcoal fitted top, high-waisted dark teal streetwear trousers, and practical
black fashion trainers. Stylish and subtly sexy but fully clothed and believable for daytime city walking. Polished
realistic 3D character concept render for MPFB/Blender modeling. Show one neutral A-pose character in four matching-scale
orthographic views: front, exact side, back, and three-quarter; full body and identical identity/outfit in every view.
Flat pale warm-gray studio background and even modeling light. No cultural costume, celebrity/franchise likeness,
brands, logos, text, jewelry, props, nudity, watermark, dramatic pose, distorted anatomy, or mismatched views.

### Braamfontein textile

Use case: stylized-concept. Asset type: tileable game garment material source. Seamless edge-to-edge rust terracotta
technical cotton micro-canvas for fitted contemporary Braamfontein streetwear. Photorealistic orthographic flat albedo,
fine crosshatch at consistent scale, subtle yarn variation, shadowless neutral capture. Seamless periodic edges; no
garment silhouette, seams, stitching, zips, pockets, folds, lighting, logos, text, watermark, or perspective.

### Sandton professional turnaround

Use case: stylized-concept. Asset type: game character production turnaround reference. Create an original, clearly
adult South African Indian woman, age 30, a Sandton professional, as a cosmopolitan Johannesburg pedestrian NPC.
Attractive and poised, with medium warm-brown skin, slim-average build, long glossy dark-brown hair in a practical low
half-up style, fitted deep-plum blazer over an ivory shell, tailored charcoal trousers, and polished low block-heel ankle
boots. Confident office-glam, subtly sexy but fully clothed. Polished realistic 3D character concept render for
MPFB/Blender modeling. Show matching-scale front, exact side, back, and three-quarter neutral A-pose views, full body and
identical identity/outfit. No cultural or ceremonial costume, bindi, celebrity/franchise likeness, brands, text,
jewelry, handbag, props, nudity, watermark, distorted anatomy, or mismatched views.

### Sandton textile

Use case: stylized-concept. Asset type: tileable game garment material source. Seamless edge-to-edge deep-plum premium
wool suiting for contemporary Sandton tailoring. Photorealistic orthographic flat albedo, very fine twill at consistent
scale, subtle charcoal yarn variation, shadowless neutral capture. Seamless periodic edges; no garment silhouette,
lapels, seams, buttons, pockets, folds, lighting, logos, text, watermark, velvet, satin, or perspective.

### Rosebank athlete turnaround

Use case: stylized-concept. Asset type: game character production turnaround reference. Create an original, clearly
adult Coloured South African woman, age 25, a Rosebank athlete, as a cosmopolitan Johannesburg pedestrian NPC.
Attractive and energetic, with golden-tan skin, strong athletic adult build, dark curly hair in a high practical
ponytail, fitted muted-coral zip training top, high-waisted graphite performance leggings, and cream-and-charcoal running
shoes. Contemporary fitted premium sportswear, subtly sexy but fully clothed. Polished realistic 3D character concept
render for MPFB/Blender modeling. Show matching-scale front, exact side, back, and three-quarter neutral A-pose views,
full body and identical identity/outfit. No competition uniform, stereotypes, celebrity/franchise likeness, brands,
text, equipment, props, nudity, watermark, distorted anatomy, or mismatched views.

### Rosebank textile

Use case: stylized-concept. Asset type: tileable game garment material source. Seamless edge-to-edge muted-coral premium
technical performance knit for a contemporary Rosebank training top. Photorealistic orthographic flat albedo, extremely
fine stretch-knit grain, subtle heathered yarn variation, shadowless neutral capture. Seamless periodic edges; no garment
silhouette, seams, zipper, panels, folds, sweat, lighting, logos, text, watermark, shiny spandex, or perspective.

### Melville creative turnaround

Use case: stylized-concept. Asset type: game character production turnaround reference. Create an original, clearly
adult White South African woman, age 29, a Melville creative, as a cosmopolitan Johannesburg pedestrian NPC. Attractive
and self-assured, with lightly freckled fair skin, curvy-average build, sharp chin-length chestnut bob, fitted
mustard-ochre knit top under an open cropped charcoal overshirt, high-waisted dark indigo jeans, and oxblood lace-up ankle
boots. Stylish art-district weekend clothing, subtly sexy but fully clothed. Polished realistic 3D character concept
render for MPFB/Blender modeling. Show matching-scale front, exact side, back, and three-quarter neutral A-pose views,
full body and identical identity/outfit. No bohemian costume clichés, celebrity/franchise likeness, brands, text,
jewelry, handbag, props, nudity, watermark, distorted anatomy, or mismatched views.

### Melville textile

Use case: stylized-concept. Asset type: tileable game garment material source. Seamless edge-to-edge mustard-ochre fine
cotton knit for a contemporary Melville weekend top. Photorealistic orthographic flat albedo, fine vertical knit ribs at
consistent scale, subtle golden-brown yarn variation, shadowless neutral capture. Seamless periodic edges; no garment
silhouette, neckline, seams, folds, lighting, logos, text, watermark, chunky wool, glitter, or perspective.

## Reproducible authoring provenance

- MPFB 2.0.16 is the GPL-3.0-or-later authoring tool and is not redistributed.
- MakeHuman system bodies, female skins, high-poly eyes, `braid01`, `long01`, `ponytail01`, `bob01`, the four selected
  female outfits, and footwear are CC0-1.0 authoring inputs. Their derived geometry/textures are shipped.
- Quaternius Universal Animation Library 2.1 Standard is CC0-1.0; `Walk_Loop` and `Sprint_Loop` provide lower-body
  locomotion timing. The remaining constrained clips are authored on the MPFB rig by the build script.
- Blender 4.2+ produces the ignored editable and interchange files; the committed optimized GLBs contain four opaque
  skinned materials, four 1K base-colour textures, and no more than four influences per vertex.
