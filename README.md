<div align="center">

<img src="icon-512.png" width="168" alt="The ziti: a golden 3D noodle with red sauce dripping down its sides" />

# ZitiCam Nippon

**Read manga on camera. The pages and your live-face ziti, recorded together in one take.**

### [Open ZitiCam Nippon](https://bkd-ziti.github.io/Ziticam-Nippon/)

![version 0.1.0](https://img.shields.io/badge/version-0.1.0-e8b45a?style=flat-square)
![phone and PC](https://img.shields.io/badge/runs_on-phone_and_PC-c8432b?style=flat-square)
![works offline](https://img.shields.io/badge/works-offline-7fbf6a?style=flat-square)

</div>

---

## why this exists

A manga review used to mean three things: a screen recording of the pages, a separate ziti clip on a key color, and hours in an editor lining them up page by page.

Nippon does all three at once. You read, you talk, you turn pages, and the video you stop is the video you post. The ziti sits wherever you put it, at whatever size, and you can move it in the middle of a take when a panel needs the room.

It's the same noodle and the same tuning as [ZitiCam Pocket](https://github.com/bkd-ziti/ziticam-pocket), running in the browser on your phone or your PC. No install, no account, no upload.

## how it works

```mermaid
flowchart LR
  manga["your manga<br/>files · folder · link"] --> stage["the stage<br/>pages + ziti"]
  cam["camera"] --> track["face tracker<br/>MediaPipe"]
  track --> ziti["the ziti<br/>three.js"]
  ziti --> stage
  stage --> rec["recorder<br/>video + your voice"]
  rec --> out["save · share<br/>TikTok, YouTube, CapCut"]
  classDef warm fill:#2a2119,stroke:#e8b45a,color:#f3e6cf
  class manga,stage,cam,track,ziti,rec,out warm
```

The ziti is drawn on a transparent layer and placed straight onto the page, so there's no key color to clean up. What you see on the stage is exactly what gets recorded; the buttons, the dashed ziti frame and the menus never appear in the video.

## make a review

1. Open the link. Tap **Start camera** and allow camera + mic.
2. **Open manga**: pick files, a folder, or paste a link.
3. Put the ziti where you want it. Drag it, pinch it (or pull the gold dot), or use the corner buttons in **Layout**.
4. Tap the red button. Read, talk, turn pages.
5. Need a breather? Hit **pause**, line up the next page, resume. The video picks up with no gap.
6. Tap stop. Watch it back, then **Save / Share**.

> Tip: on iPhone, tap **Share → Add to Home Screen** and it opens like an app. On a PC, Chrome and Edge offer **Install** in the address bar.

## what it opens

| source | how |
| --- | --- |
| **Images** | JPG, PNG, WebP, AVIF, GIF (HEIC on iPhone). Pick several at once; they sort by page number, so `2.jpg` comes before `10.jpg`. |
| **Folder** | a chapter folder on a PC, or drag the folder onto the window. |
| **CBZ / ZIP** | the usual chapter archive. Best option on iPhone. |
| **PDF** | each page is rendered sharp for 1080p. |
| **Links** | direct image links (one per line), a `.cbz` / `.zip` / `.pdf` link, a numbered range like `https://…/ch1/{01-24}.jpg`, or a gallery page with images on it. |

CBR / RAR can't be opened in a browser; re-save as CBZ.

**About links:** many manga sites block other apps from loading their images. When a site does, Nippon says so plainly. Save the chapter and use **Files** instead. Everything you open stays on your device.

Nippon remembers where you left off in each title.

## controls

| on the stage | |
| --- | --- |
| tap the left / right side | turn the page (direction follows **Manga ←** or **Comic →**) |
| swipe | turn the page |
| tap the middle | hide or show the controls, for a clean screen |
| pinch the page | zoom into a panel; drag to pan |
| drag the ziti | move it, even while recording |
| pinch the ziti / pull the gold dot | resize it |

Tall pages (webtoons, or **Fit → Width**) scroll down before they turn.

| on a PC | |
| --- | --- |
| `←` `→` | turn pages |
| `Space` / `↓` | next (scrolls tall pages first) |
| `R` | record / stop |
| `P` | pause / resume |
| `H` | hide controls |
| `Z` | ziti on / off |
| `O` | open manga |
| scroll over the ziti | resize it |
| `Ctrl` + scroll | zoom the page |

**Layout** holds the ziti size, corner presets, a backdrop (circle or card in gold, paper, ink or tomato), reading direction, page fit, where the page sits, the page-turn style, and the video shape: **9:16** for Shorts, Reels and TikTok, **16:9** for YouTube, **1:1** for feeds, at 720p or 1080p.

**Look** is the ziti itself, same as Pocket: Set straight, eyes, mouth, head follow, drift, talk bounce, calm, sauce, eyebrows, flip, mirror, the 3-2-1 countdown, and Clean / Voice mic.

## good to know

- **Leaving the app mid-take:** on iPhone, switching apps finishes the take so it isn't lost. On a PC, switching tabs pauses it; come back and resume.
- **Long takes:** the timer shows the file size as you go. Takes live in memory until you save them, so on a phone, save every 20 to 30 minutes of recording. Pause is free; paused time doesn't take up space.
- **The last take** stays available (top right) until you delete it or record a new one.
- **Offline:** after one visit with a connection, the whole app, the ziti and the face tracker open with no signal.

## under the hood

- **Face tracking:** MediaPipe Face Landmarker 0.10.35, bundled with the site so it works offline, with the CDN as a fallback.
- **The noodle:** three.js r169 rendering `ziti.glb` onto a transparent canvas, tuned identically to ZitiCam Pocket.
- **The stage:** a single 2D canvas composites the page and the ziti 30 times a second. The recorder captures that canvas plus your mic: H.264 MP4 on iPhone and Chrome, WebM where MP4 isn't available.
- **Manga:** JSZip for CBZ / ZIP, pdf.js for PDF, both bundled. Pages decode a few at a time so long chapters don't run a phone out of memory.
- **Privacy:** your camera, your face, your manga and your takes stay on your device.

## files

| file | what |
| --- | --- |
| `index.html` | the page and its styles |
| `app.js` | the stage, page turning, gestures, recording |
| `ziti.js` | the live-face ziti (shared design with Pocket) |
| `reader.js` | opening files, folders, archives, PDFs and links |
| `sw.js` | offline support |
| `ziti.glb` | the noodle |
| `face_landmarker.task`, `vendor/` | the face tracker, JSZip and pdf.js |

Run it locally with any static server, e.g. `python3 -m http.server`, then open `http://localhost:8000`. Add `?debug=1` for stats, or `?manga=<link>` to open a chapter straight away.

## credits

three.js (MIT), MediaPipe (Apache 2.0), JSZip (MIT), pdf.js (Apache 2.0). Licenses are in [`licenses/`](licenses/). The ziti and this app are made by BKDziti.
