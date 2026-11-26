# Third-party notices

The MIT license covers the original source code and documentation contributed to dust2-web. Third-party components and content retain their respective licenses and copyrights.

## Counter-Strike content

Counter-Strike and Dust II names, Valve map geometry, models, textures, animations, sounds, music, finish artwork and game imagery remain subject to the rights of Valve and their respective creators. The same applies to underlying third-party content in screenshots, Blender scenes and exported maps. This is an independent project.

## Libraries, fonts and other assets

Three.js, three-mesh-bvh, ws and Vite provide license notices in their packages. The Kenney and Quaternius CC0 notices apply to their respective assets. Barlow is distributed under the SIL Open Font License 1.1. Its copyright and license are included in `scripts/maps/mode-ui/type/OFL.txt`. Asset-specific sources and notices are listed in `docs/ASSETS.md` in the source tree and `licenses/ASSET-SOURCES.md` in the Windows portable package.

## Android GeckoView test package

The optional Android GeckoView test package includes the unmodified Mozilla GeckoView engine `157.0.20260924084938`. Its covered source is available under the [Mozilla Public License 2.0](https://www.mozilla.org/en-US/MPL/2.0/), with third-party components retaining their accompanying notices. The engine's license notices remain in the packaged Mozilla resources. Corresponding upstream sources are the [Firefox 157.0 source archive](https://archive.mozilla.org/pub/firefox/releases/157.0/source/firefox-157.0.source.tar.xz) and [GeckoView Java sources](https://maven.mozilla.org/maven2/org/mozilla/geckoview/geckoview/157.0.20260924084938/geckoview-157.0.20260924084938-sources.jar).

## Fork additions and upstream attribution

This fork is derived from [ETO-ze/dust2-web](https://github.com/ETO-ze/dust2-web) under the MIT License (`LICENSE.md`). Original source additions in this fork are likewise contributed under the MIT License, while all third-party assets and dependencies retain their own copyrights and licenses:

- **Web client next (`client-next/`)**: SolidJS (`solid-js`) and `vite-plugin-solid` (MIT), TypeScript (Apache-2.0), Three.js and `three-mesh-bvh` (MIT), Vite (MIT).
- **Control plane (`control-plane/`)**: Go standard library (BSD-3-Clause); zero external Go module dependencies.
- **Physics core (`physics-core/`)**: Rust crate contributed under the MIT License.
- **Bilibili Toy SDK**: Dynamically loaded from Bilibili's official host CDN only when executing inside the Bilibili Toy environment; the SDK itself is not redistributed in this repository and remains subject to Bilibili's platform terms.
