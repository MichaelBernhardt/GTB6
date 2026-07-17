# Johannesburg NPC cast art and build sources

These assets define sixteen wholly original, clearly adult Johannesburg identities: eight ambient pedestrians, four
mission contacts, a fictional municipal patrol officer, a rank enforcer, a car guard, and a generic driver. The generated images are
modeling and textile inputs only: they are not UV maps, real-person likenesses, or substitutes for the skinned GLBs.
`manifest.json` is the build recipe and asset contract; editable Blend/FBX files are intentionally ignored.

## Selected generated outputs

- `references/*-turnaround.png`: matching-scale front, profile, rear and three-quarter identity/outfit references.
- `materials/*-source.png`: flat textile sources blended with the luminance and layout of the real MakeHuman garment UV
  textures by `tools/npc/create-source.py`.
- `previews/*-turnaround.jpg`: Blender renders of each final MPFB source from four angles.
- `previews/*-animations.jpg`: `idle`, `walk`, `sprint`, `punch_right`, and grounded `death` inspection frames.

The 32 source images were generated with OpenAI's built-in image-generation tool on 14–15 July 2026. Under the
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

## Cast expansion prompt set

The following are the final prompts used for the 12-character expansion. No image inputs or edit prompts were used.

### Newtown producer turnaround

Use case: stylized-concept. Asset type: game character production turnaround reference. Create an original, clearly
adult Black South African man, age 28, a Newtown music producer, as a cosmopolitan Johannesburg pedestrian NPC. He has
deep warm-brown skin, a lean-average build, a compact natural afro, an indigo workwear overshirt over a clay T-shirt,
charcoal chinos, and off-white trainers. Polished realistic 3D character concept render for MPFB/Blender modeling. Show
one neutral A-pose character in four matching-scale orthographic views: front, exact side, back, and three-quarter; full
body and identical identity/outfit in every view. Flat pale warm-gray studio background and even modeling light. No
cultural costume, celebrity or franchise likeness, brands, logos, text, jewelry, props, weapons, nudity, watermark,
dramatic pose, distorted anatomy, or mismatched views.

### Newtown producer textile

Use case: stylized-concept. Asset type: tileable game garment material source. Seamless edge-to-edge deep-indigo
workwear cotton twill for a contemporary Newtown overshirt. Photorealistic orthographic flat albedo, fine diagonal twill
at consistent scale, subtle blue-black yarn variation, shadowless neutral capture. Seamless periodic edges; no garment
silhouette, seams, stitching, buttons, pockets, folds, lighting, logos, text, watermark, or perspective.

### Fordsburg restaurateur turnaround

Use case: stylized-concept. Asset type: game character production turnaround reference. Create an original, clearly
adult South African Indian man, age 31, a Fordsburg restaurateur, as a cosmopolitan Johannesburg pedestrian NPC. He has
medium warm-brown skin, an average build, short neat wavy dark hair, a muted olive button-up shirt, stone tailored
trousers, and dark-brown ankle boots. Polished realistic 3D character concept render for MPFB/Blender modeling. Show one
neutral A-pose character in four matching-scale orthographic views: front, exact side, back, and three-quarter; full body
and identical identity/outfit in every view. Flat pale warm-gray studio background and even modeling light. No cultural
or ceremonial costume, bindi, celebrity or franchise likeness, brands, logos, text, jewelry, props, nudity, watermark,
dramatic pose, distorted anatomy, or mismatched views.

### Fordsburg restaurateur textile

Use case: stylized-concept. Asset type: tileable game garment material source. Seamless edge-to-edge muted-olive brushed
cotton shirting for a contemporary smart-casual button-up. Photorealistic orthographic flat albedo, fine balanced weave
at consistent scale, subtle moss and khaki yarn variation, shadowless neutral capture. Seamless periodic edges; no
garment silhouette, collar, seams, buttons, pockets, folds, lighting, logos, text, watermark, or perspective.

### Maboneng courier turnaround

Use case: stylized-concept. Asset type: game character production turnaround reference. Create an original, clearly
adult Black South African man, age 24, a Maboneng bicycle courier, as a cosmopolitan Johannesburg pedestrian NPC. He has
deep brown skin, a wiry athletic build, a clean low fade, a fitted cobalt technical training top, graphite performance
trousers, and cream-and-black running shoes. Polished realistic 3D character concept render for MPFB/Blender modeling.
Show one neutral A-pose character in four matching-scale orthographic views: front, exact side, back, and three-quarter;
full body and identical identity/outfit in every view. Flat pale warm-gray studio background and even modeling light.
No bicycle, delivery bag, competition uniform, costume stereotype, celebrity or franchise likeness, brands, logos,
text, jewelry, props, nudity, watermark, distorted anatomy, or mismatched views.

### Maboneng courier textile

Use case: stylized-concept. Asset type: tileable game garment material source. Seamless edge-to-edge cobalt-blue
technical performance knit for a fitted contemporary courier top. Photorealistic orthographic flat albedo, extremely
fine stretch-knit grain at consistent scale, subtle heathered blue yarn variation, shadowless neutral capture. Seamless
periodic edges; no garment silhouette, seams, zipper, panels, folds, sweat, lighting, logos, text, watermark, shiny
spandex, or perspective.

### Parkhurst architect turnaround

Use case: stylized-concept. Asset type: game character production turnaround reference. Create an original, clearly
adult White South African man, age 32, a Parkhurst architect, as a cosmopolitan Johannesburg pedestrian NPC. He has fair
skin, a tall lean-average build, neat chestnut hair and light stubble, a sand cotton field jacket over a slate knit top,
dark indigo jeans, and oxblood ankle boots. Polished realistic 3D character concept render for MPFB/Blender modeling.
Show one neutral A-pose character in four matching-scale orthographic views: front, exact side, back, and three-quarter;
full body and identical identity/outfit in every view. Flat pale warm-gray studio background and even modeling light.
No safari or colonial costume, celebrity or franchise likeness, brands, logos, text, jewelry, props, nudity, watermark,
dramatic pose, distorted anatomy, or mismatched views.

### Parkhurst architect textile

Use case: stylized-concept. Asset type: tileable game garment material source. Seamless edge-to-edge warm-sand cotton
micro-canvas for a contemporary field jacket. Photorealistic orthographic flat albedo, fine crosshatch at consistent
scale, subtle beige yarn variation, shadowless neutral capture. Seamless periodic edges; no garment silhouette, seams,
stitching, buttons, pockets, folds, lighting, logos, text, watermark, or perspective.

### Auntie Portia turnaround

Use case: stylized-concept. Asset type: game character production turnaround reference. Create Auntie Portia Mokoena,
an original, clearly adult Black South African woman, age 55, and a warm but formidable Johannesburg mission contact.
She has deep warm-brown skin, a mature curvy-average build, a neat salt-and-pepper bob, a berry-maroon cardigan over a
cream shell, charcoal tailored trousers, and practical dark loafers. Polished realistic 3D character concept render for
MPFB/Blender modeling. Show one neutral A-pose character in four matching-scale orthographic views: front, exact side,
back, and three-quarter; full body and identical identity/outfit in every view. Flat pale warm-gray studio background
and even modeling light. No costume stereotype, celebrity or franchise likeness, brands, logos, text, jewelry, props,
weapons, nudity, watermark, distorted anatomy, age inconsistency, or mismatched views.

### Auntie Portia textile

Use case: stylized-concept. Asset type: tileable game garment material source. Seamless edge-to-edge berry-maroon fine
cotton knit for a contemporary cardigan. Photorealistic orthographic flat albedo, fine vertical knit ribs at consistent
scale, subtle wine and berry yarn variation, shadowless neutral capture. Seamless periodic edges; no garment silhouette,
neckline, seams, buttons, folds, lighting, logos, text, watermark, chunky wool, glitter, or perspective.

### Bra Vusi turnaround

Use case: stylized-concept. Asset type: game character production turnaround reference. Create Bra Vusi Mthembu, an
original, clearly adult Black South African man, age 44, and a streetwise Johannesburg lock-up owner and mission
contact. He has deep brown skin, a sturdy average build, close-cropped hair with a little gray, a muted teal-and-rust
micro-check shirt, dark jeans, and brown work boots. Polished realistic 3D character concept render for MPFB/Blender
modeling. Show one neutral A-pose character in four matching-scale orthographic views: front, exact side, back, and
three-quarter; full body and identical identity/outfit in every view. Flat pale warm-gray studio background and even
modeling light. No gang cliché, costume stereotype, celebrity or franchise likeness, brands, logos, text, jewelry,
props, weapons, nudity, watermark, distorted anatomy, age inconsistency, or mismatched views.

### Bra Vusi textile

Use case: stylized-concept. Asset type: tileable game garment material source. Seamless edge-to-edge muted teal-and-rust
micro-check cotton shirting. Photorealistic orthographic flat albedo, tiny regular woven check at consistent scale,
subtle aged yarn variation, shadowless neutral capture. Seamless periodic edges; no garment silhouette, collar, seams,
buttons, pockets, folds, lighting, logos, text, watermark, tartan, or perspective.

### Candice Jacobs turnaround

Use case: stylized-concept. Asset type: game character production turnaround reference. Create Candice Jacobs, an
original, clearly adult White South African woman from Boksburg, age 34, and a determined Johannesburg mission contact.
She has fair sun-warmed skin, an athletic-average adult build, dark-blonde hair in a practical ponytail, a fitted
bottle-green cropped utility jacket over a black top, black jeans, and cream trainers. Stylish and confident but fully
clothed. Polished realistic 3D character concept render for MPFB/Blender modeling. Show one neutral A-pose character in
four matching-scale orthographic views: front, exact side, back, and three-quarter; full body and identical identity and
outfit in every view. Flat pale warm-gray studio background and even modeling light. No costume stereotype, celebrity
or franchise likeness, brands, logos, text, jewelry, props, weapons, nudity, watermark, distorted anatomy, or mismatched
views.

### Candice Jacobs textile

Use case: stylized-concept. Asset type: tileable game garment material source. Seamless edge-to-edge bottle-green cotton
twill for a fitted contemporary utility jacket. Photorealistic orthographic flat albedo, fine diagonal twill at
consistent scale, subtle forest and olive yarn variation, shadowless neutral capture. Seamless periodic edges; no
garment silhouette, seams, stitching, zips, pockets, folds, lighting, logos, text, watermark, or perspective.

### Thandi Ndlovu turnaround

Use case: stylized-concept. Asset type: game character production turnaround reference. Create Thandi Ndlovu, an
original, clearly adult Black South African woman, age 38, and an authoritative independent Johannesburg shop manager
and mission contact. She has deep warm-brown skin, a strong average adult build, short natural curls, a fitted graphite
zip utility top, olive work trousers, and black ankle boots. Polished realistic 3D character concept render for
MPFB/Blender modeling. Show one neutral A-pose character in four matching-scale orthographic views: front, exact side,
back, and three-quarter; full body and identical identity/outfit in every view. Flat pale warm-gray studio background
and even modeling light. No military costume, costume stereotype, celebrity or franchise likeness, brands, logos, text,
jewelry, props, weapons, nudity, watermark, distorted anatomy, or mismatched views.

### Thandi Ndlovu textile

Use case: stylized-concept. Asset type: tileable game garment material source. Seamless edge-to-edge graphite-gray
workwear stretch weave for a fitted contemporary utility top. Photorealistic orthographic flat albedo, fine compact
basket weave at consistent scale, subtle charcoal yarn variation, shadowless neutral capture. Seamless periodic edges;
no garment silhouette, seams, zipper, pockets, folds, lighting, logos, text, watermark, shiny spandex, or perspective.

### JMPD patrol officer turnaround

Use case: stylized-concept. Asset type: game character production turnaround reference. Create Sergeant Themba Dlamini,
an original, clearly adult Black South African man, age 36, as a fictional Johannesburg municipal foot-patrol officer.
He has deep brown skin, a fit average build, a clean low fade, a plain dark-navy short utility jacket over a matching
shirt and trousers, a simple blank duty belt, and black service boots. This is a generic fictional uniform with no real
department crest, badge, insignia, or protected trade dress. Polished realistic 3D character concept render for
MPFB/Blender modeling. Show one neutral A-pose character in four matching-scale orthographic views: front, exact side,
back, and three-quarter; full body and identical identity/outfit in every view. Flat pale warm-gray studio background
and even modeling light. No real police logo, text, weapons, handcuffs, props, costume exaggeration, celebrity or
franchise likeness, brands, nudity, watermark, distorted anatomy, or mismatched views.

### JMPD patrol officer textile

Use case: stylized-concept. Asset type: tileable game garment material source. Seamless edge-to-edge dark-navy service
uniform twill for a fictional municipal patrol jacket and trousers. Photorealistic orthographic flat albedo, fine
diagonal twill at consistent scale, subtle blue-black yarn variation, shadowless neutral capture. Seamless periodic
edges; no garment silhouette, badge, insignia, patches, seams, stitching, pockets, folds, lighting, logos, text,
watermark, or perspective.

### Bree rank enforcer turnaround

Use case: stylized-concept. Asset type: game character production turnaround reference. Create Sizwe Khumalo, an
original, clearly adult Black South African man, age 33, as an imposing Bree taxi-rank enforcer and hostile NPC. He has
deep brown skin, a muscular adult build, close-cropped hair, a dark-charcoal lightly padded work jacket over a muted
burgundy shirt, dark jeans, and black work boots. Grounded modern Johannesburg streetwear, intimidating through posture
and build rather than costume. Polished realistic 3D character concept render for MPFB/Blender modeling. Show one
neutral A-pose character in four matching-scale orthographic views: front, exact side, back, and three-quarter; full body
and identical identity/outfit in every view. Flat pale warm-gray studio background and even modeling light. No gang
colors, tattoos, weapons, jewelry, costume stereotype, celebrity or franchise likeness, brands, logos, text, nudity,
watermark, distorted anatomy, or mismatched views.

### Bree rank enforcer textile

Use case: stylized-concept. Asset type: tileable game garment material source. Seamless edge-to-edge dark-charcoal matte
jacket shell fabric for contemporary padded workwear. Photorealistic orthographic flat albedo, fine dense weave at
consistent scale, subtle graphite yarn variation, shadowless neutral capture. Seamless periodic edges; no quilting,
garment silhouette, seams, stitching, zips, pockets, folds, lighting, logos, text, watermark, leather, or perspective.

### Yeoville car guard turnaround

Use case: stylized-concept. Asset type: game character production turnaround reference. Create Uncle Jabu Maseko, an
original, clearly adult Black South African man, age 52, as a personable Yeoville curbside car guard NPC. He has deep
warm-brown skin, a mature lean-average build, short salt-and-pepper hair, worn deep-navy work overalls over a charcoal
T-shirt, a plain lime high-visibility vest with no markings, and practical black work shoes. Respectful, grounded,
contemporary Johannesburg characterization. Polished realistic 3D character concept render for MPFB/Blender modeling.
Show one neutral A-pose character in four matching-scale orthographic views: front, exact side, back, and three-quarter;
full body and identical identity/outfit in every view. Flat pale warm-gray studio background and even modeling light.
No text, logos, slogans, props, costume stereotype, celebrity or franchise likeness, brands, weapons, nudity, watermark,
distorted anatomy, age inconsistency, or mismatched views.

### Yeoville car guard textile

Use case: stylized-concept. Asset type: tileable game garment material source. Seamless edge-to-edge worn deep-navy
cotton workwear drill for practical overalls. Photorealistic orthographic flat albedo, firm diagonal weave at consistent
scale, subtle faded blue yarn variation, shadowless neutral capture. Seamless periodic edges; no garment silhouette,
seams, stitching, pockets, grease stains, folds, lighting, logos, text, watermark, or perspective.

### Johannesburg driver turnaround

Use case: stylized-concept. Asset type: game character production turnaround reference. Create Zane Daniels, an
original, clearly adult Coloured South African man, age 39, as an everyday Johannesburg commuter and generic ejected
driver NPC. He has golden-brown skin, an average adult build, short dark curls, a clean dusty steel-blue crew-neck
T-shirt, charcoal jeans, and gray trainers. Ordinary contemporary city clothing with a distinct believable identity.
Polished realistic 3D character concept render for MPFB/Blender modeling. Show one neutral A-pose character in four
matching-scale orthographic views: front, exact side, back, and three-quarter; full body and identical identity/outfit
in every view. Flat pale warm-gray studio background and even modeling light. No occupational costume, stereotype,
celebrity or franchise likeness, brands, logos, text, jewelry, props, weapons, nudity, watermark, distorted anatomy, or
mismatched views.

### Johannesburg driver textile

Use case: stylized-concept. Asset type: tileable game garment material source. Seamless edge-to-edge dusty steel-blue
cotton jersey for a clean contemporary crew-neck T-shirt. Photorealistic orthographic flat albedo, extremely fine knit
grain at consistent scale, subtle slate-blue yarn variation, shadowless neutral capture. Seamless periodic edges; no
garment silhouette, neckline, seams, stitching, folds, lighting, logos, text, watermark, stains, or perspective.

## Reproducible authoring provenance

- MPFB 2.0.16 is the GPL-3.0-or-later authoring tool and is not redistributed.
- MakeHuman system bodies, female skins, high-poly eyes, `braid01`, `long01`, `ponytail01`, `bob01`, the four selected
  female outfits, male and middle-age skins, the selected short/afro hairstyles, male/female outfits, and footwear are
  CC0-1.0 authoring inputs. Their derived geometry/textures are shipped.
- Walk and sprint cycles are retargeted from the CMU Graphics Lab Motion Capture Database (subjects 08 and 09, BVH
  conversion; free for all uses, database funded by NSF EIA-0196217). The remaining constrained clips are authored on
  the MPFB rig by the build script.
- Blender 4.2+ produces the ignored editable and interchange files; the committed optimized GLBs contain four opaque
  skinned materials, four 1K base-colour textures, and no more than four influences per vertex.
