# Changelog

## [v0.15.0](https://github.com/HeavenlyEntity/chamoji-ai/compare/v0.14.0...v0.15.0) - 2026-11-09

### Highlights

- 📦 **Publishing to npm**
  - ✨ Release and publish on merge from the Action ([a7adb42](https://github.com/HeavenlyEntity/chamoji-ai/commit/a7adb4219f180fa56a502d864d4ccc4e53863eb7))
  - ✨ Catch up releases that never reached npm ([9f584c6](https://github.com/HeavenlyEntity/chamoji-ai/commit/9f584c64e37983a3e5599c9c1783514e6a845ee8))
  - ✨ Hold breaking changes for a manual release when asked ([a6799d1](https://github.com/HeavenlyEntity/chamoji-ai/commit/a6799d1def52253dea2c562d67c1de23b5b20fc4))
  - ✨ Release and publish in one command ([ed285dd](https://github.com/HeavenlyEntity/chamoji-ai/commit/ed285ddd950b546597eb012792266e621f20c039))
  - ✨ Add chamoji publish ([3b8a4e0](https://github.com/HeavenlyEntity/chamoji-ai/commit/3b8a4e08571fede132e1f78b0a4546cbdb69d029))
  - ✨ Publish tarballs with npm, skipping what's already there ([76fc1da](https://github.com/HeavenlyEntity/chamoji-ai/commit/76fc1da59d9fabd3e2dea9b9deda0603b068ec92))
  - ✨ Plan a publish with every check before anything is published ([31f8b08](https://github.com/HeavenlyEntity/chamoji-ai/commit/31f8b0808d0e9ac9c1825be7ad28147f52f9f705))
  - ✨ Add the npm runner, registry and dist-tag rules ([0454c45](https://github.com/HeavenlyEntity/chamoji-ai/commit/0454c45145cfe9b7e81aa4cb7edb8aaa4a86b507))
  - ✨ Pack packages with the workspace's own package manager ([ef12bd3](https://github.com/HeavenlyEntity/chamoji-ai/commit/ef12bd39e69ea068956e2ce1a6c849d9473981a1))
  - ✨ Tell apps from libraries by framework and entry points ([8e110d8](https://github.com/HeavenlyEntity/chamoji-ai/commit/8e110d8b81664324bea18eead37b50c116f13bcb))
  - ✨ Add release trigger, majors and publish settings ([e07ef92](https://github.com/HeavenlyEntity/chamoji-ai/commit/e07ef920755de84b1f2cdf0b7be9f1cc9bae4715))
  - 🐛 Run gh in the repo being released, and keep tests off the real gh ([38c47b7](https://github.com/HeavenlyEntity/chamoji-ai/commit/38c47b70ad924a9aadc24805055a519cf59df6c2))
  - 🐛 Finish GitHub releases and recovery that publishing left undone ([92e406a](https://github.com/HeavenlyEntity/chamoji-ai/commit/92e406ab2aef64033cbe1913b4da768593fb723e))
  - 🐛 Ask for provenance only when npm can sign it ([a9f9f0e](https://github.com/HeavenlyEntity/chamoji-ai/commit/a9f9f0ebba489c8485ef5ab00596f0111ab60a0b))
  - 🐛 Skip apps when catching up instead of failing the tag ([df78afe](https://github.com/HeavenlyEntity/chamoji-ai/commit/df78afe9c34a794f5326ebd108e6fadf3aa8616b))
  - 🐛 Push the release commit and tags atomically ([2590e18](https://github.com/HeavenlyEntity/chamoji-ai/commit/2590e18827caea1334d9871637fc145be87cf098))
  - 🔒️ Run token npm lookups outside the repo so its .npmrc can't proxy them ([e7d950e](https://github.com/HeavenlyEntity/chamoji-ai/commit/e7d950e64135026fe418b5d6a62bcc2e9eaf1cd4))
  - 🔒️ Keep publish credentials away from git hooks and registry lookups ([cdca67f](https://github.com/HeavenlyEntity/chamoji-ai/commit/cdca67f7e5773bde5b226c8c373ecccbd9049dc2))
  - 🔐 Check npm credentials before anything is tagged ([07cdf94](https://github.com/HeavenlyEntity/chamoji-ai/commit/07cdf941c2c8845e330b488ad726f6fc8f0769f0))
  - 📝 Make the publishing docs and small edges match what runs ([4bde2bf](https://github.com/HeavenlyEntity/chamoji-ai/commit/4bde2bf45fa6775d6f3af3e7e6f7566b9b243e6a))
  - ✅ Make the publish tests pass on Windows ([7bd77c4](https://github.com/HeavenlyEntity/chamoji-ai/commit/7bd77c4d8faee9866f620a653493f7bb5ead5247))
  - ✅ Keep the runner's GitHub variables out of the Action tests ([fa6afc0](https://github.com/HeavenlyEntity/chamoji-ai/commit/fa6afc037a6fed9f79cf9f696a34425b8791af89))
  - ✅ Check that publish mode makes the tag's GitHub release ([dc7b069](https://github.com/HeavenlyEntity/chamoji-ai/commit/dc7b06973f70fb4b0844c604b01700f4e8fe6e73))
- 🧠 **Project memory**
  - 📝 Note an illustration of merge styles and project memory ([37c3f73](https://github.com/HeavenlyEntity/chamoji-ai/commit/37c3f7347924a4c8420f70be539ccb5f32e33631))

### Changed

- 🔧 Ship the publishing workstream ([14612e7](https://github.com/HeavenlyEntity/chamoji-ai/commit/14612e7d109e41e359546d2604e0373010d8f2b0))

### Security

- 🔒️ Send security reports to the private report form ([070fe57](https://github.com/HeavenlyEntity/chamoji-ai/commit/070fe5715315c947ffd805b38e914d0054b54e57))
- 🔒️ Allow only each docs component's own attributes ([273ded8](https://github.com/HeavenlyEntity/chamoji-ai/commit/273ded879d2590f19155cd1efa064be90dc5bcb5))
- 🔒️ Check code block titles and link schemes in the docs pages ([ae0cfde](https://github.com/HeavenlyEntity/chamoji-ai/commit/ae0cfde800dd28e247e9904622e9e4dd673d6ecd))

### Documentation

- 📝 Show the latest release next to the readme's Action examples ([76d29bb](https://github.com/HeavenlyEntity/chamoji-ai/commit/76d29bb30ea6eee9c8fc5fb7d4f3eb926ac4838a))
- 📝 Pin the readme's and release skill's Action examples to v0.14.0 ([91104d8](https://github.com/HeavenlyEntity/chamoji-ai/commit/91104d86314755e2e36edec7727c41b2c285f60c))
- 📝 Point the contributing guide at pnpm benchmark ([#1](https://github.com/HeavenlyEntity/chamoji-ai/issues/1)) ([dcd0b45](https://github.com/HeavenlyEntity/chamoji-ai/commit/dcd0b452e3e7e261255e8183fd4589f6f503b805))
- 📝 Design and plan the sponsors page ([149be95](https://github.com/HeavenlyEntity/chamoji-ai/commit/149be95353aaf3278d44fa2ae44d0985c9932894))
- 📝 Paste the Prettier-stable sponsors block ([26a5771](https://github.com/HeavenlyEntity/chamoji-ai/commit/26a5771551a7dfa19babec6e00fef2a17f391068))
- 📝 Add a Sponsors section to the README ([a3594a1](https://github.com/HeavenlyEntity/chamoji-ai/commit/a3594a1b5b5ca6b06f58167aa4c702aff12d0bc8))
- 📝 Mark monorepo releases shipped and npm publishing next ([555bef5](https://github.com/HeavenlyEntity/chamoji-ai/commit/555bef5f22374ae9f38150c529e0c74bac27d85c))
- 📝 Correct the Action, card and agent guides and the key location ([1d7ca51](https://github.com/HeavenlyEntity/chamoji-ai/commit/1d7ca5192523130a06a035a9fa410bdd65f35c0f))
- 📝 Write the last four guides for the docs site ([5fac786](https://github.com/HeavenlyEntity/chamoji-ai/commit/5fac7861abb85985ffca9ec7bd9a72991c35c195))
- 📝 Correct the monorepo and composer facts in the guides ([7da4a86](https://github.com/HeavenlyEntity/chamoji-ai/commit/7da4a86572754f2065241503fb237e9919538311))
- 📝 Write the first four guides for the docs site ([ea6954f](https://github.com/HeavenlyEntity/chamoji-ai/commit/ea6954f96db986b4c53e12b99a1737317c03ad62))
- 📝 Correct the hook and mcp pages and settle the since tags ([b90ecad](https://github.com/HeavenlyEntity/chamoji-ai/commit/b90ecadc71b58a1b8616b5f32c34d0b7f7bbdda1))
- 📝 Write the last six command pages for the docs site ([1175e3c](https://github.com/HeavenlyEntity/chamoji-ai/commit/1175e3c0db11d9d293671a22439dbb6566bed499))
- 📝 Correct the monorepo facts on the command pages ([902c0e8](https://github.com/HeavenlyEntity/chamoji-ai/commit/902c0e8fe3cf02b3fa16da6cd20e517b4b328d27))
- 📝 Write the first six command pages for the docs site ([8268092](https://github.com/HeavenlyEntity/chamoji-ai/commit/8268092ee651281a94e3c7205aa50d3b0222b955))
- 📝 Correct facts on the Reference and Install pages ([a35379b](https://github.com/HeavenlyEntity/chamoji-ai/commit/a35379b14f3d41dc64c433eed9b7b7ba2a1023d4))
- 📝 Write the Get started and Reference pages for the docs site ([7f240fc](https://github.com/HeavenlyEntity/chamoji-ai/commit/7f240fc04b4248897f3da154331d50ca50290ec3))

### Maintenance

- ✅ Parse the docs pages and allow only the known components ([2512f2b](https://github.com/HeavenlyEntity/chamoji-ai/commit/2512f2bdcde93e4b10b5a0b5d9281535746a34f5))
- ✅ Check the docs site's pages and nav ([d8eace3](https://github.com/HeavenlyEntity/chamoji-ai/commit/d8eace3fbccb11cdc83c6757cb1886473f4aa5f6))

### Miscellaneous

- 🔗 Point the brand guide's React Bits link at React Bits Pro ([21fc01e](https://github.com/HeavenlyEntity/chamoji-ai/commit/21fc01e189bd10c4f2642f4f867a41669f45edcb))

## [v0.14.0](https://github.com/HeavenlyEntity/chamoji-ai/compare/v0.13.0...v0.14.0) - 2026-11-04

### Added

- ✨ Point init, the welcome and the composer at chamoji setup ([d437eb2](https://github.com/HeavenlyEntity/chamoji-ai/commit/d437eb2e4c6c76d1e60a8368fd66cdd8f5f0549f))
- ✨ Give chamoji setup its screen, with a live preview ([a1cbce0](https://github.com/HeavenlyEntity/chamoji-ai/commit/a1cbce0cdf9f5ff89de6afd0eb1e122b8bb560bb))
- ✨ Add chamoji setup with --yes, --json, --explain and its four steps ([44f6625](https://github.com/HeavenlyEntity/chamoji-ai/commit/44f6625329cb2989c59bb7245e8fe509b28318e1))
- ✨ Preview the next release and replay past ones under setup's answers ([4744bc3](https://github.com/HeavenlyEntity/chamoji-ai/commit/4744bc3b02c2db203a0e60b0a2139ce8d339ed57))
- ✨ Turn what setup found into answers, questions and a release section ([c9f3780](https://github.com/HeavenlyEntity/chamoji-ai/commit/c9f378059ea54762f47889f5fbfab319c6f248e7))
- ✨ Find the template remote, the starting point and squashed syncs ([2f750eb](https://github.com/HeavenlyEntity/chamoji-ai/commit/2f750ebacb328e26c6b77e38456ce9846572e0f5))
- ✨ Tell inherited, stray and learned tags apart for setup ([ef00641](https://github.com/HeavenlyEntity/chamoji-ai/commit/ef00641c7ccd0511523eab6af57625b11a576807))
- ✨ Work out a repo's apps, packages and version files for setup ([f369346](https://github.com/HeavenlyEntity/chamoji-ai/commit/f369346a13f6677759d3b7d79e71d24f9074ca39))

### Changed

- 💬 Say a mixed repo's published packages stay internal, and ask 1.0.0 apps once ([d88cab0](https://github.com/HeavenlyEntity/chamoji-ai/commit/d88cab02f8be2998bcf03ca2686957a0fbdf24bd))

### Fixed

- 🐛 Wait for the preview and replay before the setup screen hands back ([86e72ec](https://github.com/HeavenlyEntity/chamoji-ai/commit/86e72ece0cc50a94eeff3c53f09271cf80dd117c))
- 🐛 Name no template authors in a fork-workflow clone ([4a26ed4](https://github.com/HeavenlyEntity/chamoji-ai/commit/4a26ed4ede11ed8cb00ee31e3c4584bf7972f559))
- 🐛 Advise on squash merges that keep a blank or PR-description body ([f80ac6e](https://github.com/HeavenlyEntity/chamoji-ai/commit/f80ac6ee57e8042add17ab76369d6a2e874c3bd0))
- 🐛 Count release-dependents as own in the composer, and replay versions as read ([c9f91f8](https://github.com/HeavenlyEntity/chamoji-ai/commit/c9f91f8c403081dabe85222a59e27e613784d868))
- 🐛 Take a newline as Enter on the setup screen ([886c340](https://github.com/HeavenlyEntity/chamoji-ai/commit/886c340e626171368cf2e57ca5e387a708fdaa68))
- 🐛 Spare own tags with a lookahead instead of listing every template tag ([878f9d4](https://github.com/HeavenlyEntity/chamoji-ai/commit/878f9d4e98adf4ab4466e7fdca5ab056d0f0c161))
- 🐛 Keep template commits out of first notes, recognised by author too ([d8cd119](https://github.com/HeavenlyEntity/chamoji-ai/commit/d8cd119b8631e5c4371117afb6bb57a8c7aadc04))
- 🐛 Fix Task 8 review findings: welcome copy, raw trailers, renames, per-clone hint ([fb966fe](https://github.com/HeavenlyEntity/chamoji-ai/commit/fb966fe6dff06660d1e854b51e475d94d584667f))
- 🐛 Show the version before in setup's preview, ask the terminal's theme and print step states once ([226f900](https://github.com/HeavenlyEntity/chamoji-ai/commit/226f9000d43227d69c7ade4c27949b0f490fe9b9))
- 🐛 Let an offered hook count as settled, so setup exits 0 when nothing else is left ([9e34f20](https://github.com/HeavenlyEntity/chamoji-ai/commit/9e34f208513e4e57a15b492fe9cc55645bd81bc2))
- 🐛 Read setup's config through core, refuse links, strip output and exit 0 when settled ([cdf9785](https://github.com/HeavenlyEntity/chamoji-ai/commit/cdf978503fb929a85d601b9fbe0f4117061a4322))
- 🐛 Read tags for every candidate unit and keep the article in base-name copy ([e2c36f2](https://github.com/HeavenlyEntity/chamoji-ai/commit/e2c36f272bc5f0a89252eacd4abb43e51d59aa93))
- 🐛 Leave a section that means the same alone, and fill setup answers from detection ([6e53196](https://github.com/HeavenlyEntity/chamoji-ai/commit/6e5319616f428ca43a1477530de543cb52ffa011))
- 🐛 Keep a unit's own tags out of setup's ignore patterns ([8539cab](https://github.com/HeavenlyEntity/chamoji-ai/commit/8539cabd691e6dbb1159d1e4b8e9b5b18a15df58))

### Documentation

- 📝 Document upstream.authors and mark 7.5 as built, not done ([763ebf1](https://github.com/HeavenlyEntity/chamoji-ai/commit/763ebf1b999181d79191badcb3ef4ccd11ba9d09))
- 📝 Document chamoji setup and close milestone 7.5 ([f8cdd55](https://github.com/HeavenlyEntity/chamoji-ai/commit/f8cdd55c02d2b586160aee564dface7dc8ece4d8))
- 📝 Plan chamoji setup and mark the engine shipped in 0.13.0 ([c26c06a](https://github.com/HeavenlyEntity/chamoji-ai/commit/c26c06a0f5d3fe99a1a4a451edfa5d3a49d509b2))

## [v0.13.0](https://github.com/HeavenlyEntity/chamoji-ai/compare/v0.12.1...v0.13.0) - 2026-11-04

### Added

- 🔊 Warn when the upstream remote has nothing fetched ([79ce84c](https://github.com/HeavenlyEntity/chamoji-ai/commit/79ce84ce012a050ddb661253781056e32bb6dddf))
- ✨ Release, notes and previews per unit in the Action ([bf489c0](https://github.com/HeavenlyEntity/chamoji-ai/commit/bf489c0615e2dc66ede3f35bf600e066205cb2aa))
- ✨ Release each unit from the CLI ([69579a9](https://github.com/HeavenlyEntity/chamoji-ai/commit/69579a981ebfc0db82ef6360a384f131b59e3d7f))
- ✨ Plan, apply and push releases per unit ([10ab7d8](https://github.com/HeavenlyEntity/chamoji-ai/commit/10ab7d8c9f68bdd5ada2b42d88f750a2f4d631b0))
- ✨ Write each unit's notes in its changelog's own style ([f3efad1](https://github.com/HeavenlyEntity/chamoji-ai/commit/f3efad1cd281c997f09cdda458c23baa4348bb05))
- ✨ Set a unit's version in every file that carries it ([e8f7401](https://github.com/HeavenlyEntity/chamoji-ai/commit/e8f7401786967a61bd7f0efdf154df65ad51adfc))
- ✨ Work out each unit's next version ([3c1f80a](https://github.com/HeavenlyEntity/chamoji-ai/commit/3c1f80afc93291c08bf8fee4c43ef957c8d999f4))
- ✨ Leave template history out and show each sync as one line ([459a2bc](https://github.com/HeavenlyEntity/chamoji-ai/commit/459a2bccbec4336d25b00fbd60bc095fe4af2494))
- ✨ Work out which commits belong to which unit ([e935251](https://github.com/HeavenlyEntity/chamoji-ai/commit/e93525168ca76d6619c12518571a249bb36daedd))
- ✨ Read every unit's tags in any format ([80b336a](https://github.com/HeavenlyEntity/chamoji-ai/commit/80b336ab8294819aae984ef7a589630da26a408f))
- ✨ Find workspace packages and what each unit uses ([78af248](https://github.com/HeavenlyEntity/chamoji-ai/commit/78af2484558def8ed8332537577f85d27b2df1ed))
- ✨ Read release settings from chamoji.config.json ([0226b5d](https://github.com/HeavenlyEntity/chamoji-ai/commit/0226b5dc1baf55bda029b182e827b1c284c309c8))

### Changed

- ♻️ Share the release steps between single and unit releases, and count every waiting unit ([f0e63e2](https://github.com/HeavenlyEntity/chamoji-ai/commit/f0e63e29eac1dacfa28e1df12a1bca1b09d68d06))
- ♻️ Edit dependency ranges with the version-file scanner and explain fixed releases ([a65d8d2](https://github.com/HeavenlyEntity/chamoji-ai/commit/a65d8d2b8260c96e1be3b4f8b9e6f27cefab3015))
- 🔧 Start the monorepo-releases workstream ([11bd958](https://github.com/HeavenlyEntity/chamoji-ai/commit/11bd9589383a5321058bdafe16ab7e2b8d7edc10))

### Fixed

- 🐛 Print the notes a release committed for changelog --for-tag ([76e963e](https://github.com/HeavenlyEntity/chamoji-ai/commit/76e963ea2d69159d7082a7ac942e07a1880990cc))
- 🐛 Release a fixed group's shared tag once, and push tags by full ref ([afa3a16](https://github.com/HeavenlyEntity/chamoji-ai/commit/afa3a1646855ef997845f7158485f2cb0c292e4c))
- 🐛 Scope the unit PR preview to the PR and fix prerelease detection ([434d1f4](https://github.com/HeavenlyEntity/chamoji-ai/commit/434d1f4847fa6bd74ce35d6936aed445f47b0511))
- 🐛 Say when --unit left a unit out instead of saying it needs no release ([4027991](https://github.com/HeavenlyEntity/chamoji-ai/commit/40279917508bd1b4b9d76836dab2e2252a6c763a))
- 🐛 Find the exported config object without being fooled by comments or arrows ([7a1e630](https://github.com/HeavenlyEntity/chamoji-ai/commit/7a1e630f421b0792762609ceab4b882632713b96))
- 🐛 Keep calver versions valid semver ([21ba16c](https://github.com/HeavenlyEntity/chamoji-ai/commit/21ba16c17741ed096ca702861b77d60c124d65fa))
- 🐛 Keep upstream merges and option-like config out of syncs ([03dfd8e](https://github.com/HeavenlyEntity/chamoji-ai/commit/03dfd8e18e7ffdd4ba13e848b854cc230985e078))
- 🐛 See the same workspace packages the package manager sees ([4947388](https://github.com/HeavenlyEntity/chamoji-ai/commit/4947388848d2ad607e528cff69246dab0107450d))
- 🐛 Fail loudly on unreadable manifests and skip folders no glob reaches ([47e7fc8](https://github.com/HeavenlyEntity/chamoji-ai/commit/47e7fc8c80377d3cf10b90271ba2aed6478c2a9e))

### Security

- 🔒️ Refuse to write a unit release through a symlink ([40c5769](https://github.com/HeavenlyEntity/chamoji-ai/commit/40c57693d42910eb0440747d131a8a21fb298d81))
- 🔒️ Refuse Expo configs and version files chamoji could misread ([b9088ea](https://github.com/HeavenlyEntity/chamoji-ai/commit/b9088ea0b71a692fdabd016bf1449f82ac4a1a8a))
- 🔒️ Check release settings for unit-only keys, shared tag templates and paths outside the repo ([09eb3ee](https://github.com/HeavenlyEntity/chamoji-ai/commit/09eb3eec12a71fedd1a2e12c7038d4fcc7d8815f))
- 🔒️ Let unit PR previews run only node or chamoji ([366cb17](https://github.com/HeavenlyEntity/chamoji-ai/commit/366cb1785912e0ddffb4f8a614427451e7bef17b))
- 🔒️ Make the unit PR preview fail closed on anything the PR could control ([df967c3](https://github.com/HeavenlyEntity/chamoji-ai/commit/df967c3ea20137af73935930793e955d762fda56))
- 🔒️ Run the unit PR preview with a trusted CLI and no secrets ([2424545](https://github.com/HeavenlyEntity/chamoji-ai/commit/2424545fe5e6df46861fc4461aa9eb8be03b8501))

### Documentation

- 📝 Correct the monorepo readme and the MARKETING_VERSION message ([0353ac0](https://github.com/HeavenlyEntity/chamoji-ai/commit/0353ac0438de363fc779d84476a734a9a7c2ee52))
- 📝 Document monorepo releases and prove 0.12 compatibility ([9e14980](https://github.com/HeavenlyEntity/chamoji-ai/commit/9e14980a744962f90aa0990f6474858777d187c3))
- 📝 Plan the monorepo release engine for milestone 7.5 ([4e5a200](https://github.com/HeavenlyEntity/chamoji-ai/commit/4e5a2006ca253e730b0c0bdd58bca75dd03f5193))
- 📝 Design monorepo releases and chamoji setup ([090e49c](https://github.com/HeavenlyEntity/chamoji-ai/commit/090e49c58ba2c11794826218bd360256ac230533))

### Maintenance

- 💚 Give Windows tests a minute before they time out ([9b734d3](https://github.com/HeavenlyEntity/chamoji-ai/commit/9b734d372984d8fcf769db1854dba5a0414c8fa5))
- 💚 Build the CLI in every Windows test shard ([4ea2c7b](https://github.com/HeavenlyEntity/chamoji-ai/commit/4ea2c7be7e4bade062564ea89fbfcb27e4f194b0))
- 👷 Split the Windows tests across three jobs ([3eb13ea](https://github.com/HeavenlyEntity/chamoji-ai/commit/3eb13eadce13348bc04484ca286034dd7fec087b))

## [v0.12.1](https://github.com/HeavenlyEntity/chamoji-ai/compare/v0.12.0...v0.12.1) - 2026-11-04

### Fixed

- 🐛 Refuse release settings this version can't follow ([797da7f](https://github.com/HeavenlyEntity/chamoji-ai/commit/797da7fbc87affbda5b7ada8fc3dd2c0e9b60501))
- 🐛 Fix the terminal face's Ctrl-Z, late OSC reply and missing blank line ([e3176ed](https://github.com/HeavenlyEntity/chamoji-ai/commit/e3176ed361361b1d22c4b8d9ca85e10af3f3aa07))

### Documentation

- 📝 Show chamoji's own card and tick off the roadmap leftovers ([372b221](https://github.com/HeavenlyEntity/chamoji-ai/commit/372b221f6db8347e3935a98ca02505c9e141c60d))
- 📝 Add monorepo releases and npm publishing to the roadmap ([171f368](https://github.com/HeavenlyEntity/chamoji-ai/commit/171f36893346d90ffff4e348033a08f673ed990f))

### Maintenance

- 💚 Give the purge-sync test more time on Windows ([dfe8302](https://github.com/HeavenlyEntity/chamoji-ai/commit/dfe8302c854011d8a93c5c287d69782e791ee087))

## [v0.12.0](https://github.com/HeavenlyEntity/chamoji-ai/compare/v0.11.0...v0.12.0) - 2026-11-04

### Highlights

- 😎 **Terminal face**
  - ✨ Add the animated welcome and regroup the help ([96eb05b](https://github.com/HeavenlyEntity/chamoji-ai/commit/96eb05bb6d980a8fd49c449f7fc6d7093b857750))
  - ✨ Show faces in the commands that wait ([f74ba63](https://github.com/HeavenlyEntity/chamoji-ai/commit/f74ba632851281a9f336369b2175161bfef918e3))
  - ✨ Add the face settings, gitStep and Jev's progress ([e803a46](https://github.com/HeavenlyEntity/chamoji-ai/commit/e803a46847754c739551106da1ad30d2732ac8b3))
  - ✨ Report sync steps and keep network git quiet ([8982f3b](https://github.com/HeavenlyEntity/chamoji-ai/commit/8982f3b6abfb723dad6c59c92aee3567ed66476f))
  - ✨ Add the face helper ([cffe1e4](https://github.com/HeavenlyEntity/chamoji-ai/commit/cffe1e443ac5a400931f07b8e6db1461608a569d))
  - ✨ Add the wordmark frames and their generator ([3f1b962](https://github.com/HeavenlyEntity/chamoji-ai/commit/3f1b962c82816812beb7b110835573871dce08c1))
  - ✨ Add the one-line faces and the ASCII fallback ([28e8c67](https://github.com/HeavenlyEntity/chamoji-ai/commit/28e8c67b1323176d4f8123954e4bf1417436a12e))
  - ✨ Add the foil colour and theme detection ([cc348bc](https://github.com/HeavenlyEntity/chamoji-ai/commit/cc348bc98f354480678ebae67f18c760235d6bc1))
  - 🔧 Start the terminal face workstream ([4c62794](https://github.com/HeavenlyEntity/chamoji-ai/commit/4c62794fbdb85c179544cc037cba39a24e884cb5))
  - 🐛 Treat every ssh "Permission denied (" as a credentials failure ([1a4756d](https://github.com/HeavenlyEntity/chamoji-ai/commit/1a4756db60fbfceadf57e039aa77ee62466a16fa))
  - 🐛 End a planning step warn when Jev left commits unsorted ([d995a2e](https://github.com/HeavenlyEntity/chamoji-ai/commit/d995a2e015739393988626acd1a5510dfefd616f))
  - 🐛 Ask the terminal for its theme only from the foreground, and only once a face draws ([ff03fc9](https://github.com/HeavenlyEntity/chamoji-ai/commit/ff03fc9e1ab351176c94e00fbc89342da86fda12))
  - 🐛 Retry a quiet tag fetch, count a failed Jev and let Ctrl-C through ([4aea810](https://github.com/HeavenlyEntity/chamoji-ai/commit/4aea81074440d3171e0dd6c05149b38cf1ce670b))
  - 🐛 Leave ssh alone when GIT_SSH is set ([13bcb22](https://github.com/HeavenlyEntity/chamoji-ai/commit/13bcb2220e20ef92f3810f5227dd53edee1ea75c))
  - 🐛 Keep partial text when the face first draws ([4f99012](https://github.com/HeavenlyEntity/chamoji-ai/commit/4f99012f3da967534aa17a874ba777808b19c01e))
  - 🐛 Keep swallowing a late terminal reply ([32d4b72](https://github.com/HeavenlyEntity/chamoji-ai/commit/32d4b72e4e6d6f8f8b221ccd515122f1563f4e9c))
  - 📝 Correct the terminal section of the brand guide ([9247330](https://github.com/HeavenlyEntity/chamoji-ai/commit/92473309449b0f6244a9ec366c20ac35d26326b9))
  - 📝 Record the first real terminal check ([00efe43](https://github.com/HeavenlyEntity/chamoji-ai/commit/00efe43b3e72c520d6bf213e158b7aa78fbfd386))
  - 📝 Record the terminal face: brand, roadmap, readme and results ([66ce0fc](https://github.com/HeavenlyEntity/chamoji-ai/commit/66ce0fcef866d4bc2c873bab0094f3de118a22d1))
  - 💚 Make the face and release tests pass on Windows ([c912e46](https://github.com/HeavenlyEntity/chamoji-ai/commit/c912e4660e92a6ed0faa7e704af84c6901f0de50))

### Changed

- 🔧 Ship the terminal face workstream and use its tagline ([902ed98](https://github.com/HeavenlyEntity/chamoji-ai/commit/902ed98269c423a4d9bbcda3df015eef0a529b08))

### Documentation

- 📝 Plan the terminal face build ([74bcde2](https://github.com/HeavenlyEntity/chamoji-ai/commit/74bcde2f6b0768d30c1edfd04d13583ee477d470))
- 📝 Give the terminal face a wink and sunglasses ([50b5b9d](https://github.com/HeavenlyEntity/chamoji-ai/commit/50b5b9d17ac7a9c79c61b5eeedb6accefe3f01bf))
- 📝 Draw the terminal wordmark from Marow Block ([5955a2e](https://github.com/HeavenlyEntity/chamoji-ai/commit/5955a2e10badb57fcbc763b4428646d8b27d19c9))
- 📝 Settle the terminal background check for the foil ([21b068a](https://github.com/HeavenlyEntity/chamoji-ai/commit/21b068a02c092136d22c52bec340dd6f129937e9))
- 📝 Design the terminal face, animated logo and help screen ([0acc5b0](https://github.com/HeavenlyEntity/chamoji-ai/commit/0acc5b077d841035497289026cc1ae4ee3905a8c))

## [v0.11.0](https://github.com/HeavenlyEntity/chamoji-ai/compare/v0.10.1...v0.11.0) - 2026-11-03

### Highlights

- 🧠 **Project memory**
  - ✨ Make AI agents write an intent card when they commit ([6617b21](https://github.com/HeavenlyEntity/chamoji-ai/commit/6617b2194c2121cc58050df63d51419b882340b3))
  - ✨ Serve project memory to AI agents with chamoji mcp ([0e561b5](https://github.com/HeavenlyEntity/chamoji-ai/commit/0e561b5f3ff7ad9d814d3a17f5ac4f6dcf9f930c))
  - ✨ Search project memory with BM25 and an optional Jev rerank ([90f36b6](https://github.com/HeavenlyEntity/chamoji-ai/commit/90f36b698f9b1611c415e5c26bf834ef75855a31))
  - ✨ Share project memory between clones ([635063c](https://github.com/HeavenlyEntity/chamoji-ai/commit/635063cf17704a99c18e9f555dd88e010f8d1481))
  - ✨ Keep workstream summaries in refs/chamoji/memory ([a7ab28b](https://github.com/HeavenlyEntity/chamoji-ai/commit/a7ab28b5a445c3a0f949e6b0c1bed30e20a94c7a))
  - ✨ Add chamoji why to explain a line ([2fd0da6](https://github.com/HeavenlyEntity/chamoji-ai/commit/2fd0da6a8fb8f7dea6a8366e3cc22b4c1858b660))
  - ✨ Read intent cards from commit messages ([9915976](https://github.com/HeavenlyEntity/chamoji-ai/commit/991597675b1379edb354f8b8d8277003bc7e6420))
  - ⏪️ Stop carrying foreign tree entries, and let the pre-push hook run ([2af8565](https://github.com/HeavenlyEntity/chamoji-ai/commit/2af8565326d5b5a088e667a90565259eb1d05c89))
  - 🐛 Fix the issues found in the final review of project memory ([46fbf39](https://github.com/HeavenlyEntity/chamoji-ai/commit/46fbf39fd63adb812373abd93a71e6869dae08a5))
  - 🐛 Keep the agent hook from blocking commits and from changing shared files ([800050c](https://github.com/HeavenlyEntity/chamoji-ai/commit/800050c9df3de7c30d94e99e605f3de569209189))
  - 🐛 Stop a pushed tip or a forged entry from erasing memory ([7f39c18](https://github.com/HeavenlyEntity/chamoji-ai/commit/7f39c18f8cc3e979a4f9a10784785f4b0b1ec5d1))
  - 🐛 Keep odd commit dates from poisoning a memory entry ([8edea34](https://github.com/HeavenlyEntity/chamoji-ai/commit/8edea345347bb5028063fee1fae5a3911385fd93))
  - 🐛 Read wrapped intent values and survive odd trailer keys ([a86ea5f](https://github.com/HeavenlyEntity/chamoji-ai/commit/a86ea5fc8d568689def5d76991ae1cd0857ad6fe))
  - 🔒️ Redact the whole of a long email address ([7ecdfd6](https://github.com/HeavenlyEntity/chamoji-ai/commit/7ecdfd6581aa81279c482175411b159432021c3a))
  - 🔒️ Bound the why body, lock down temp files, stop inviting the opt-out ([78c225f](https://github.com/HeavenlyEntity/chamoji-ai/commit/78c225f13e0d1e293d05c0a70413ee5d852fab42))
  - 🔒️ Bound and sanitize what chamoji mcp sends to the model ([1ce0773](https://github.com/HeavenlyEntity/chamoji-ai/commit/1ce0773d50f13fa3a1abe167684ee3475970ee91))
  - 🔒️ Keep commit text and tracked env files out of the memory rerank ([641c6f0](https://github.com/HeavenlyEntity/chamoji-ai/commit/641c6f098777639eff431fe26a8be767bb2ffd14))
  - 🔒️ Drop any stored commit that HEAD has but this workstream doesn't name ([7e65c78](https://github.com/HeavenlyEntity/chamoji-ai/commit/7e65c78736027558d36e609909371ca64fb3c3d7))
  - 🔒️ Frame commit records with NUL so commit text can't forge them ([fde7e01](https://github.com/HeavenlyEntity/chamoji-ai/commit/fde7e019ef7f35d2e188e76e6ae11cac1528f92a))
  - 📝 Record the merge and the plan for 0.11.0 ([188edfb](https://github.com/HeavenlyEntity/chamoji-ai/commit/188edfbc5632cb1b433e1874aa83fb92d12a60fc))
  - 📝 Drop the docs for foreign entries and --no-verify ([289e296](https://github.com/HeavenlyEntity/chamoji-ai/commit/289e296f30088b725ff22d4bbbf6c0c84f62b6a7))
  - 📝 Document the final review fixes for project memory ([843e325](https://github.com/HeavenlyEntity/chamoji-ai/commit/843e32508a39510aa7d8331ed8d4d3300b2689cf))
  - 📝 Correct the project memory docs after review ([12d3b93](https://github.com/HeavenlyEntity/chamoji-ai/commit/12d3b936784547f7bb94e823bcdeed4721651729))
  - 📝 Document project memory and record milestone 7 ([d066fad](https://github.com/HeavenlyEntity/chamoji-ai/commit/d066fadcac6314aef053642399bd965d745d0927))
  - 📝 Plan milestone 7, Project memory ([641cb6c](https://github.com/HeavenlyEntity/chamoji-ai/commit/641cb6c9603668a853e04911e91fb321ac4994c1))
  - 💚 Make the memory and MCP tests pass on Windows ([d74e169](https://github.com/HeavenlyEntity/chamoji-ai/commit/d74e1694c1f649fae83644e548dbe40adafff713))
  - 💚 Keep the huge-body test within argument limits ([323626e](https://github.com/HeavenlyEntity/chamoji-ai/commit/323626effabcc02b506af522a44fe6fdf9ece854))

### Changed

- 🔧 Mark the project memory workstream shipped ([caa2c91](https://github.com/HeavenlyEntity/chamoji-ai/commit/caa2c914fa233cf210114dbc30e07078554a8145))
- Update funding sources in FUNDING.yml ([b12ec3a](https://github.com/HeavenlyEntity/chamoji-ai/commit/b12ec3aee3b48f488b62dcbedff82db47d5d6b5f))

### Documentation

- 📝 Mark workstreams shipped in 0.10.0, with dogfooding left ([3d26938](https://github.com/HeavenlyEntity/chamoji-ai/commit/3d269388c22f362b00bbed2512d0dc813ee37331))

## [v0.10.1](https://github.com/HeavenlyEntity/chamoji-ai/compare/v0.10.0...v0.10.1) - 2026-11-01

### Fixed

- 🐛 Give ws switch the same hook check as ws start ([b645381](https://github.com/HeavenlyEntity/chamoji-ai/commit/b645381085f8c8c7c1f6ea3bd04c27dbcb177e6a))
- 🐛 Stop ws start promising stamps when no hook will add them ([fdacc78](https://github.com/HeavenlyEntity/chamoji-ai/commit/fdacc781d8f6e8ab1c5d0ae361f101b6887ddf3f))

## [v0.10.0](https://github.com/HeavenlyEntity/chamoji-ai/compare/v0.9.0...v0.10.0) - 2026-11-01

### Added

- ✨ Add chamoji ws, and stamp the active workstream ([ef0afd0](https://github.com/HeavenlyEntity/chamoji-ai/commit/ef0afd077d4e6227ee1b604c2fbd6a4daedaa441))
- ✨ Render Highlights in Markdown and HTML ([5c7a05c](https://github.com/HeavenlyEntity/chamoji-ai/commit/5c7a05c9c5d45a746ba3045167e09c617b0a2dd6))
- ✨ Fold shipped workstreams into Highlights ([52b5f62](https://github.com/HeavenlyEntity/chamoji-ai/commit/52b5f629e28f7b2ed332f5997b25a21333b9598b))
- ✨ Read the Workstream trailer ([2df559d](https://github.com/HeavenlyEntity/chamoji-ai/commit/2df559d5f2655a924260580314adb11c8beee873))
- ✨ Add workstreams to core ([52b2da8](https://github.com/HeavenlyEntity/chamoji-ai/commit/52b2da83ebe97a0262034fca5dfe5f7cefa9b691))

### Changed

- ♻️ Make the workstream field optional ([6f33e2e](https://github.com/HeavenlyEntity/chamoji-ai/commit/6f33e2e10148ca55f9b4d3f92a3f7e2f4a26b011))

### Fixed

- 🐛 Show ws start's stderr when the hook e2e check fails ([a6b2e74](https://github.com/HeavenlyEntity/chamoji-ai/commit/a6b2e7425231448a0c710b70f50dc575044c554c))
- 🐛 Pad the ws list title so the commit counts line up ([a1010eb](https://github.com/HeavenlyEntity/chamoji-ai/commit/a1010eb6c453ad9cc0ab24447049f52496e0c3e5))
- 🐛 Keep long hand-written lines in the workstreams file unfolded ([dee3486](https://github.com/HeavenlyEntity/chamoji-ai/commit/dee348653eeb0e15ffbf396cebfab3540a80e75f))
- 🐛 Report ws outside a repo and under an ignored .chamoji plainly ([a7343d4](https://github.com/HeavenlyEntity/chamoji-ai/commit/a7343d44235c937f3455a7b672d6a6ae2a3ab48c))
- 🐛 Stamp a -m message that starts with # ([f252add](https://github.com/HeavenlyEntity/chamoji-ai/commit/f252add64c9afdfa2d6c7d8bec8618339c03ab13))
- 🐛 Count a sign-off-only message as empty, as git does ([62ca858](https://github.com/HeavenlyEntity/chamoji-ai/commit/62ca85869630d4ded6d70ddea70fcf9617cfa4ea))
- 🐛 Never let the stamp turn an aborted commit into a commit ([6013d77](https://github.com/HeavenlyEntity/chamoji-ai/commit/6013d77d0d4fc8d9225e5607a18bec5c85bd4f01))

### Security

- 🔒️ Refuse alias bombs and symlinks in workstreams ([f7b47a2](https://github.com/HeavenlyEntity/chamoji-ai/commit/f7b47a2b7d9dc8f4fa4b3d972e212482ecb35b63))

### Documentation

- 📝 Record the GitHub squash results ([249b1f7](https://github.com/HeavenlyEntity/chamoji-ai/commit/249b1f7fa2c00f3b891a9cb8fb1f4f6ffb1964d6))
- 📝 Say what the hook checks and the squash test really cover ([ddd3c57](https://github.com/HeavenlyEntity/chamoji-ai/commit/ddd3c575f64ccfa04b2ba1d0ffbc6d68a28d06fa))
- 📝 Document the revert subject and committing a ship before preview ([3221ac8](https://github.com/HeavenlyEntity/chamoji-ai/commit/3221ac80368dca286f7f8427f2a07dcdf1c5b5c8))
- 📝 Document workstreams and record the exit criteria ([5c784ee](https://github.com/HeavenlyEntity/chamoji-ai/commit/5c784ee0ea2ea8b9527632d051a00043dbf3300e))
- 📝 Plan milestone 6, Workstreams ([1dd6bcc](https://github.com/HeavenlyEntity/chamoji-ai/commit/1dd6bcc587776cdaf6e3ce2f3f0c7dd72a71d9f2))

## [v0.9.0](https://github.com/HeavenlyEntity/chamoji-ai/compare/v0.8.0...v0.9.0) - 2026-10-31

### Added

- ✨ Save the repo card to its own branch from the Action ([31deefb](https://github.com/HeavenlyEntity/chamoji-ai/commit/31deefba971f96e8c307a73a8eaed365f195c731))
- ✨ Add chamoji card ([30f5fc1](https://github.com/HeavenlyEntity/chamoji-ai/commit/30f5fc17f1a0efbefd2674e9c3af4608eb1d5f11))
- ✨ Work out a repo's card stats ([b0cad9f](https://github.com/HeavenlyEntity/chamoji-ai/commit/b0cad9f2b47134937ef4a37adf7aaaacebbcfc65))

### Changed

- 📄 Add a contact email to the copyright line ([2972877](https://github.com/HeavenlyEntity/chamoji-ai/commit/2972877ef3278dc9739eccecd7a285196e34112e))
- 📄 Put chamoji under AMWARE Technologies LLC ([3f88950](https://github.com/HeavenlyEntity/chamoji-ai/commit/3f88950e825c895925cb03a47828df6b5ffda5b0))

### Fixed

- 🐛 Report a refused card as refused, and tidy the card's branch check and docs ([53c73f6](https://github.com/HeavenlyEntity/chamoji-ai/commit/53c73f6539fbf87ba35d3fd1cca4acb8950fc045))
- 🐛 Keep the card bytes intact and push only over what was inspected ([3db01e8](https://github.com/HeavenlyEntity/chamoji-ai/commit/3db01e8750a87106204294f5df50fab2170943ff))

### Documentation

- 📝 Mark the repo card shipped ([6dd6119](https://github.com/HeavenlyEntity/chamoji-ai/commit/6dd6119f324a0a705f0cbbca3b503999149066d2))
- 📝 Say the 60-day schedule pause applies to public repositories ([f9c5e1d](https://github.com/HeavenlyEntity/chamoji-ai/commit/f9c5e1da3e387773fd567b1178780365b992a187))
- 📝 Run the repo card on chamoji and document it ([4be37df](https://github.com/HeavenlyEntity/chamoji-ai/commit/4be37dfe0ce5b95425aca7cb07ad12514f24e4fd))
- 📝 Plan the repo card ([9739273](https://github.com/HeavenlyEntity/chamoji-ai/commit/973927322b84c1ae54a99b37909700751fe7457b))

### Maintenance

- 💚 Wait for the composer's prompts in the hook checks ([a39f6c4](https://github.com/HeavenlyEntity/chamoji-ai/commit/a39f6c4f930a23f7f1b9c2827a7a738e7e455cb7))

## [v0.8.0](https://github.com/HeavenlyEntity/chamoji-ai/compare/v0.7.0...v0.8.0) - 2026-10-29

### Added

- ✨ Preselect Jev's gitmoji in the composer ([ff1f526](https://github.com/HeavenlyEntity/chamoji-ai/commit/ff1f52667a5091fb0120c923a12b6d7a17b1ec27))
- ✨ Ask Jev for gitmoji, breaking and split advice at commit time ([6a329f8](https://github.com/HeavenlyEntity/chamoji-ai/commit/6a329f88b6366a34f9593cf464a2b664c1472041))
- ✨ Add Jev's judgment cache and a staged-changes reader ([15fef1d](https://github.com/HeavenlyEntity/chamoji-ai/commit/15fef1d1b2777b11bd4523376b0d677de963a700))

### Changed

- 🚸 Preselect Jev's gitmoji only when it's very sure ([0cf3bca](https://github.com/HeavenlyEntity/chamoji-ai/commit/0cf3bcacd84f3d6c5ca05fe11f26cd4c92571a73))
- ⚡️ Don't ask Jev again about commits it already sorted ([eacb5a6](https://github.com/HeavenlyEntity/chamoji-ai/commit/eacb5a60b46349fa253d2d91c581817cf0269fda))

### Security

- 🔒️ Keep the composer's AI opt-in out of the repository ([173a010](https://github.com/HeavenlyEntity/chamoji-ai/commit/173a0108ce046d983d5058195e56705a9e769d3b))
- 🔒️ Close three ways staged secrets could reach Jev ([653dca8](https://github.com/HeavenlyEntity/chamoji-ai/commit/653dca8ce1b3def0847129de0261f10ac7c26048))

### Documentation

- 📝 Mark the composer and Jev milestones shipped ([0699caf](https://github.com/HeavenlyEntity/chamoji-ai/commit/0699caf06097f823763d964069246c6d1abbd2cf))
- ✏️ Use npm i -g in the install instructions ([e905d09](https://github.com/HeavenlyEntity/chamoji-ai/commit/e905d09a2d1b12699af9ec039752fe26caa5a2fe))
- 📝 Measure Jev in the composer and document it ([b1a744c](https://github.com/HeavenlyEntity/chamoji-ai/commit/b1a744c6c8e4c1b8c9b647bb4e9260ab0c35979d))

### Maintenance

- 💚 Make two tests pass on Windows ([e4b8254](https://github.com/HeavenlyEntity/chamoji-ai/commit/e4b82543a23c281799a2a4e2ee3adc64e484a15c))

## [v0.7.0](https://github.com/HeavenlyEntity/chamoji-ai/compare/v0.6.0...v0.7.0) - 2026-10-28

### Added

- ✨ Add the commit composer, chamoji commit and hook run ([2e16b44](https://github.com/HeavenlyEntity/chamoji-ai/commit/2e16b440c8fc03e62038eb83691a9e584aa7e86b))
- ✨ Add chamoji hook install and uninstall ([fa9abc1](https://github.com/HeavenlyEntity/chamoji-ai/commit/fa9abc1ce8797efb9d166f30968efadcd50017ee))
- ✨ Add the commit composer's core: messages, search, config and hook rules ([a95e4af](https://github.com/HeavenlyEntity/chamoji-ai/commit/a95e4afe58146da97517a4a9e987d8252cca7c56))

### Documentation

- 📝 Document the commit composer and hook ([4c8a3f5](https://github.com/HeavenlyEntity/chamoji-ai/commit/4c8a3f5225ab4955bee8257cd4c831ec84a81f9c))
- 📝 Record the waitlist site's custom domain, chamoji.dev ([e25a4a6](https://github.com/HeavenlyEntity/chamoji-ai/commit/e25a4a60e3afba1ae901501736f16937343538bd))

### Maintenance

- 👷 Check the commit hook end to end in each shell and hook manager ([a6f5312](https://github.com/HeavenlyEntity/chamoji-ai/commit/a6f531201c40e036c25fb5ab306ed242d93319d1))

## [v0.6.0](https://github.com/HeavenlyEntity/chamoji-ai/compare/v0.5.0...v0.6.0) - 2026-10-28

### Added

- ✨ Read Component: and \[tag\] prefixes in plain commit subjects ([b41685b](https://github.com/HeavenlyEntity/chamoji-ai/commit/b41685b8930865be210830ab7dac4dc65a446a23))

### Changed

- ⚡️ Point the release skill at chamoji release and the Action ([67087a5](https://github.com/HeavenlyEntity/chamoji-ai/commit/67087a52fe1d13ca41b2138fa02a6bda6f9e3e77))

### Fixed

- 🐛 File typo fixes under Documentation, not Fixed ([a4e2f58](https://github.com/HeavenlyEntity/chamoji-ai/commit/a4e2f58b238e2cb8fa3afb75e6c2f7886a2549e7))

### Documentation

- 📝 Record 0.5.0 and the Action's exit criteria as met ([dfe4f77](https://github.com/HeavenlyEntity/chamoji-ai/commit/dfe4f7763a3fc9b095f81a03085e04fdc6ee7c15))

## [v0.5.0](https://github.com/HeavenlyEntity/chamoji-ai/compare/v0.4.0...v0.5.0) - 2026-10-28

### Added

- ✨ Add the chamoji GitHub Action ([5930551](https://github.com/HeavenlyEntity/chamoji-ai/commit/59305514b8346ab73ce78a30a6b4d3945ea4c580))
- ✨ Add changelog --since for branch previews ([29265aa](https://github.com/HeavenlyEntity/chamoji-ai/commit/29265aa4bd003eec8052034cfa355724df18434e))
- 📈 Add the benchmark script and two messy repos ([9d39cb2](https://github.com/HeavenlyEntity/chamoji-ai/commit/9d39cb295d1cf48bb769787c381da4bd62ed017f))
- ✨ Add chamoji release ([b26f258](https://github.com/HeavenlyEntity/chamoji-ai/commit/b26f25868ee1b7d97fe9d3e319b4a3fd5a31e21d))
- ✨ Apply and push releases in core ([1e516ba](https://github.com/HeavenlyEntity/chamoji-ai/commit/1e516ba893c95b9e0009e361ec367b3d87d24379))
- ✨ Plan releases in core ([452b783](https://github.com/HeavenlyEntity/chamoji-ai/commit/452b78320264265b93a19286824736f84add4e83))
- ✨ Add release text helpers to core ([8de9d3f](https://github.com/HeavenlyEntity/chamoji-ai/commit/8de9d3f512352f7ced8c4359f02529beffcde5aa))
- ✨ Add the chamoji-release skill for coding agents ([7323709](https://github.com/HeavenlyEntity/chamoji-ai/commit/7323709e95d8c2412101fa1fa2021c3140ec9bd3))

### Changed

- 💄 Make the readme demo three captioned screens ([2800fe9](https://github.com/HeavenlyEntity/chamoji-ai/commit/2800fe9ecff2c50666664f91ab7ccaff8071bf45))
- ⚡️ Make the release skill one command ([70a6149](https://github.com/HeavenlyEntity/chamoji-ai/commit/70a614906b8401d522b0e378d70ac630652ee53a))
- 🎨 Add the render script for the waitlist hero props ([a6ed30c](https://github.com/HeavenlyEntity/chamoji-ai/commit/a6ed30c9e2dec93f5382bf3692b657776aba4d16))
- 🍱 Drop the downloads badge until npm has data ([025074f](https://github.com/HeavenlyEntity/chamoji-ai/commit/025074fea500a3587efedd88b17327d64d864aa5))
- 🍱 Add the foil logo and badges to the readme ([1978bd1](https://github.com/HeavenlyEntity/chamoji-ai/commit/1978bd1cd1831cce0d8638babdc42691be6d39f7))

### Fixed

- 🐛 Date tagged releases in UTC like --release does ([6635ed9](https://github.com/HeavenlyEntity/chamoji-ai/commit/6635ed942ae5be54fa48fc358df31cb85350de05))

### Security

- 🔒️ Only update the Action's own PR comment ([d5cdec6](https://github.com/HeavenlyEntity/chamoji-ai/commit/d5cdec618b93e773318275b022301d4dbe7aa3f6))
- 🔒️ Stop the release script passing git arguments through a shell ([12dde8c](https://github.com/HeavenlyEntity/chamoji-ai/commit/12dde8c109e55e1fb84677ec4ba9dce11f3196ba))

### Documentation

- 📝 Add the readme demo ([9b453b0](https://github.com/HeavenlyEntity/chamoji-ai/commit/9b453b04736781b267df9c67601ed7c48f85ff9b))
- 📝 Document chamoji release and cut our releases with it ([a1111dc](https://github.com/HeavenlyEntity/chamoji-ai/commit/a1111dc888fc2364aaa4d041311742bb548dea6b))
- 📝 Mark the Cloud waitlist page live in the roadmap ([9d0ea14](https://github.com/HeavenlyEntity/chamoji-ai/commit/9d0ea1463b9e1fcfaa2c750566b51b903f57a1ea))
- 📝 Add Know as the headline font for hero and closing lines ([694227a](https://github.com/HeavenlyEntity/chamoji-ai/commit/694227a9e4a54cad5226ac56ed25e4e8ecaaae52))
- 📝 Switch brand icons to Phosphor duotone from Iconify ([b867430](https://github.com/HeavenlyEntity/chamoji-ai/commit/b8674303aed7fec47e30ca8d1ae6deacf4544ac3))
- 📝 Note the agentframe storytelling pattern and its private-repo limit ([e603254](https://github.com/HeavenlyEntity/chamoji-ai/commit/e6032544521253e4b77a6498678463139e44b456))
- 📝 Choose GSAP for storytelling and set icon and motion rules ([a6dba7c](https://github.com/HeavenlyEntity/chamoji-ai/commit/a6dba7ccb9fd50196cc9f4919266192d59838aeb))
- 📝 Note the TBA price on the waitlist page ([d3572bc](https://github.com/HeavenlyEntity/chamoji-ai/commit/d3572bc565621bd9cb7c3db477ea4b922680e9c3))
- 📝 Record that pricing is tested with the waitlist first ([981fc92](https://github.com/HeavenlyEntity/chamoji-ai/commit/981fc921d166de5613689d330974f3540f4b75a1))
- 📝 Link the waitlist design from the roadmap ([08f9b63](https://github.com/HeavenlyEntity/chamoji-ai/commit/08f9b63583ebe25052778aa66f96cde4ba2bf472))
- 📝 Mark old npm versions deprecated ([d138052](https://github.com/HeavenlyEntity/chamoji-ai/commit/d138052fb6b4dcdb09ea73dfdb22ed6cf6938a97))
- 📝 Mark the About text done ([568c8c0](https://github.com/HeavenlyEntity/chamoji-ai/commit/568c8c05210e5b2c994389f72270606fc6c7cc8b))
- 📝 Record milestone 2 progress: v0.4.0 published with provenance ([258bb0f](https://github.com/HeavenlyEntity/chamoji-ai/commit/258bb0f7ca01156ee99fcfbd0d708e9b1b377576))

### Maintenance

- 💚 Explain trusted-publishing failures in the release workflow ([98b40fa](https://github.com/HeavenlyEntity/chamoji-ai/commit/98b40fad8ede830f06bdbdd22bd497965735a626))
- 💚 Let npm use trusted publishing in the release workflow ([910629f](https://github.com/HeavenlyEntity/chamoji-ai/commit/910629f31ff3677ab57c49193c8ca4eac926e1c3))
- 💚 Fix the release workflow's npm publish step ([71efb31](https://github.com/HeavenlyEntity/chamoji-ai/commit/71efb315dddafb194cc75787c25ec3927c0b58c3))

## [v0.4.0](https://github.com/HeavenlyEntity/chamoji-ai/compare/v0.3.0...v0.4.0) - 2026-10-28

### Added

- ✨ Put CI and test commits under a new Maintenance section ([b271d78](https://github.com/HeavenlyEntity/chamoji-ai/commit/b271d78d0d3a144f123ebb5525431ae92b4969f1))
- ✨ Tell users when a newer chamoji is available ([2f96b24](https://github.com/HeavenlyEntity/chamoji-ai/commit/2f96b24caac7f6963ef04542209187f753cf5dfb))

### Changed

- 🎨 Use Tansa Bold for UI elements ([2fd7b55](https://github.com/HeavenlyEntity/chamoji-ai/commit/2fd7b553c2991306353bd2586ca3541ac3dd8ece))
- 🎨 Rebrand with Marow Block and the Iridescence foil ([ae8bb18](https://github.com/HeavenlyEntity/chamoji-ai/commit/ae8bb18f9521e8223ce682bf3d7766aae874ac04))
- 🎨 Add the brand guide from the original chamoji logo ([3af185d](https://github.com/HeavenlyEntity/chamoji-ai/commit/3af185df6566714f62f3cfd9a741b38c52d7bf30))

### Fixed

- 🐛 Harden the update check after review ([a46186b](https://github.com/HeavenlyEntity/chamoji-ai/commit/a46186bd5ed3d1bb8e5f7d612eae52deded0cef3))

### Documentation

- 📝 Close the CI/test mapping backlog item ([f9291bf](https://github.com/HeavenlyEntity/chamoji-ai/commit/f9291bf9bf63b1b28b9193e4d9747d2d7ed527cd))
- 📝 Record launch decisions and link packages to GitHub ([af60eb3](https://github.com/HeavenlyEntity/chamoji-ai/commit/af60eb3a7467a7528d990f95ca6acb382ceb0ebc))
- 📝 Log CI and test commits listed as features (dogfood) ([0f19b22](https://github.com/HeavenlyEntity/chamoji-ai/commit/0f19b229c9f589dcc774144519ae5be944c347b2))
- 📝 Add code of conduct, security policy and GitHub templates ([05d6afe](https://github.com/HeavenlyEntity/chamoji-ai/commit/05d6afe03fd68d124c57d8c18862b94d7d1cf47c))
- 📝 Plan milestone 2: public launch kit ([2dff3c6](https://github.com/HeavenlyEntity/chamoji-ai/commit/2dff3c6b904c9ddb6d08ea59fa762f4f7cde7d95))
- 📝 Record that Tansa may be embedded in our app and website ([45da53a](https://github.com/HeavenlyEntity/chamoji-ai/commit/45da53aa86d91d3ac082dece2dbc68e98ef08658))
- 📝 Record that Marow Block may be embedded in our app and website ([f9819fa](https://github.com/HeavenlyEntity/chamoji-ai/commit/f9819fa74e139347c7b33f47c1b4a6d2a2abec11))

### Maintenance

- 👷 Add CI and a release workflow with npm provenance ([f26f1c8](https://github.com/HeavenlyEntity/chamoji-ai/commit/f26f1c8d80d71bd49e9573bf61c9f3ae3176df2d))
- ✅ Make test fixtures and path tests work on Windows ([c147eed](https://github.com/HeavenlyEntity/chamoji-ai/commit/c147eedc664375b28051502c69ebe82afd0be842))

## [v0.3.0](https://github.com/HeavenlyEntity/chamoji-ai/compare/v0.2.0...v0.3.0) - 2026-10-28

### Added

- ✨ Read TYPESAFE_API_KEY from .env.local or .env ([65262b6](https://github.com/HeavenlyEntity/chamoji-ai/commit/65262b659bdc70f129aa66462c319eed5ee9858f))

### Changed

- 🔨 Add pnpm release script ([dfe9fe1](https://github.com/HeavenlyEntity/chamoji-ai/commit/dfe9fe101978e8d4ea37130c711373cb3a0c25b5))

### Fixed

- 🐛 Make pnpm release atomic, strict about flags, and Windows-safe ([2c40d7f](https://github.com/HeavenlyEntity/chamoji-ai/commit/2c40d7fe3391284edcef1caef68a3151936c1d13))

### Documentation

- 📝 Record milestone 1.6 results and plan the update notice ([e5c7454](https://github.com/HeavenlyEntity/chamoji-ai/commit/e5c745455626cd5e17a12c98f8ac9d8ce901d82b))
- 📝 Add a contributing guide and a default Documentation section ([24901e0](https://github.com/HeavenlyEntity/chamoji-ai/commit/24901e0e94e5a8c33bc015f0e9032ca8e523e861))
- 📝 Plan milestone 1.6: use chamoji on its own repo ([acff618](https://github.com/HeavenlyEntity/chamoji-ai/commit/acff6181078d5cfd04d6b21182413d6c1ae43205))
- 📝 Make the roadmap our single plan and add the dogfooding track ([dd806ab](https://github.com/HeavenlyEntity/chamoji-ai/commit/dd806ab473f8739d632033c8831e4e4233e4301d))
- 📝 Add the product roadmap ([5dd4b77](https://github.com/HeavenlyEntity/chamoji-ai/commit/5dd4b77108b81d5640b5fd25b9b1dfe33ab140ef))

## [v0.2.0](https://github.com/HeavenlyEntity/chamoji-ai/compare/v0.1.0...v0.2.0) - 2026-10-28

### Added

- ✨ Add --ai: sort leftover commits with Jev ([2ccb6d4](https://github.com/HeavenlyEntity/chamoji-ai/commit/2ccb6d440ee8b5c4afd3714424a53a836d535206))
- ✨ Add an optional classifier hook for commits no rule can sort ([312bc9b](https://github.com/HeavenlyEntity/chamoji-ai/commit/312bc9bc98d7d0fa53964215ea2e93107602ba48))
- ✨ Cover more plain-message patterns: Document, bump, \[BREAKING\], init ([4256814](https://github.com/HeavenlyEntity/chamoji-ai/commit/4256814c84881d1d34e1f95a0f57ed172cdf9289))
- ✨ Collapse dependency updates into one Dependencies line ([d47b4bd](https://github.com/HeavenlyEntity/chamoji-ai/commit/d47b4bdb0e5b550ba54b7e2f29b16bead7935b6d))
- ✨ Sort plain commit messages into sections with wording rules ([7f6316a](https://github.com/HeavenlyEntity/chamoji-ai/commit/7f6316af9e2e6a507d95c4819018c3d09d7457a8))

### Changed

- 🥅 Explain truncated or non-ASCII TypeSafe API keys ([45e49d6](https://github.com/HeavenlyEntity/chamoji-ai/commit/45e49d6e64b9a1929c220481414a5afa0e24c0f1))

### Fixed

- 🐛 Keep dev-prefixed package names and count Dependabot group updates ([322ceb0](https://github.com/HeavenlyEntity/chamoji-ai/commit/322ceb0cbc02827df0525c323323512d7c304387))
- 🐛 Tighten wording rules found too broad in review ([805b680](https://github.com/HeavenlyEntity/chamoji-ai/commit/805b68077db74c641d86a184d0f394b6baaf40ae))

### Security

- 🔒️ Send less to Jev and fail safely ([4124a2f](https://github.com/HeavenlyEntity/chamoji-ai/commit/4124a2f0985cfb917a5f1395d008e967ec615cd8))

### Documentation

- 📝 Update changelog for v0.2.0 ([3896372](https://github.com/HeavenlyEntity/chamoji-ai/commit/3896372fb7127a12f0196929f1cea2ea778db8be))
- 📝 Position review packets against Graphite's current features ([fc2087b](https://github.com/HeavenlyEntity/chamoji-ai/commit/fc2087b2947f7a19d3fa1d89d73c1b1f5edd6e3c))
- 📝 Plan review packets and the editor extension ([dd84b6f](https://github.com/HeavenlyEntity/chamoji-ai/commit/dd84b6fd846525580da8750d060818c7333881ee))

### Miscellaneous

- 🙈 Ignore .env files ([1a6bbae](https://github.com/HeavenlyEntity/chamoji-ai/commit/1a6bbae0e555ae4148c41750910ac3f0194aa653))

## v0.1.0 - 2026-10-28

### Added

- ✨ Add changelog and next-version commands ([f537dd0](https://github.com/HeavenlyEntity/chamoji-ai/commit/f537dd0e134ca464385fe02986bf2e3f5ecac65b))
- ✨ Render changelog as Markdown, HTML and JSON ([6534516](https://github.com/HeavenlyEntity/chamoji-ai/commit/653451665376bee4075f4892f823c06d474f9e39))
- ✨ Build releases from git tags and history ([9fc678c](https://github.com/HeavenlyEntity/chamoji-ai/commit/9fc678c240d693be814fbe92153661f9f4cfa948))
- ✨ Group commits by gitmoji and suggest next version ([cceb96b](https://github.com/HeavenlyEntity/chamoji-ai/commit/cceb96bab1a273fa5e03442549d54354f01d9bf1))
- ✨ Parse gitmoji and Conventional Commit messages ([b167edb](https://github.com/HeavenlyEntity/chamoji-ai/commit/b167edba111b12973d93424e1ee4996f82aebcab))
- 🎉 Set up pnpm workspace with core and cli packages ([1d97d78](https://github.com/HeavenlyEntity/chamoji-ai/commit/1d97d784a05668615f69148e4af0ddd504238391))
- 🎉 Baseline: Ink prototype before milestone 1 restructure ([c95c072](https://github.com/HeavenlyEntity/chamoji-ai/commit/c95c0725941ba3277a66613cea15d3c4c52460cb))

### Changed

- 📦️ Prepare @chamoji/cli and @chamoji/core for npm ([53d4541](https://github.com/HeavenlyEntity/chamoji-ai/commit/53d454176c326496c941a13e2ab4ec32b8b9fdc8))
- 🎨 Apply Prettier formatting ([3328801](https://github.com/HeavenlyEntity/chamoji-ai/commit/33288012714c5c881f7bdf762ee94018e59742a2))

### Fixed

- 🐛 Fix issues found in branch review ([2dd5580](https://github.com/HeavenlyEntity/chamoji-ai/commit/2dd55803db0867036212e399916d77a762f05ca2))

### Security

- 🔒️ Escape stray backticks in Markdown commit text ([e006665](https://github.com/HeavenlyEntity/chamoji-ai/commit/e0066655526a7b8e3815ad16cc87457eb2d42c34))

### Documentation

- 📝 Add generated changelog ([5ff690f](https://github.com/HeavenlyEntity/chamoji-ai/commit/5ff690fe65463ed18f607b249ee37803c29c1265))
