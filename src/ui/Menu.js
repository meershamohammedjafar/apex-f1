import { el, RowList, addSettingsRows } from "./MainMenu.js";
const SCREEN_PAUSE = "pause";
const SCREEN_SETTINGS = "settings";
export class Menu {
  constructor(ctx, mount) {
    this.ctx = ctx;
    this.isOpen = false;
    this.screen = SCREEN_PAUSE;
    this.root = el("div", "mm mm-pause");
    this.root.setAttribute("role", "dialog");
    const scrim = el("div", "mm-scrim");
    scrim.addEventListener("pointerdown", () => this.close());
    this.root.appendChild(scrim);
    const frame = el("div", "mm-frame");
    const header = el("div", "mm-header");
    const brand = el("div", "mm-brand");
    brand.appendChild(el("span", "mm-wordmark", "PAUSED"));
    brand.appendChild(el("span", "mm-brand-sub", "APEX Formula One"));
    header.appendChild(brand);
    const venue = el("div", "mm-venue");
    this._venueName = el("div", "mm-venue-name", "");
    this._venueMeta = el("div", "mm-venue-meta", "");
    venue.append(this._venueName, this._venueMeta);
    header.appendChild(venue);
    frame.appendChild(header);
    this.body = el("div", "mm-body");
    frame.appendChild(this.body);
    this.hint = el("div", "mm-hint");
    frame.appendChild(this.hint);
    this.root.appendChild(frame);
    mount.appendChild(this.root);
    this.list = new RowList(this.body, () => this._render());
    this._onKeyDown = (event) => this._handleKey(event);
    this._onPause = () => this.toggle();
    ctx.events?.on("game:pause", this._onPause);
  }
  _render() {
    this.list.clear();
    if (this.screen === SCREEN_SETTINGS) {
      addSettingsRows(this.list, this.ctx);
      this.list.addRow("Back", "", {
        kind: "action",
        onActivate: () => {
          this.screen = SCREEN_PAUSE;
          this.list.focusIndex = 0;
        }
      });
      this.hint.textContent = "Changes apply immediately  ·  Esc returns";
    } else {
      this.list.addRow("Resume", "", {
        kind: "action",
        onActivate: () => this.close()
      });
      this.list.addRow("Restart session", "", {
        kind: "action",
        onActivate: () => this._restart()
      });
      this.list.addRow("Settings", "", {
        kind: "action",
        onActivate: () => {
          this.screen = SCREEN_SETTINGS;
          this.list.focusIndex = 0;
        }
      });
      if (this.ctx.mainMenu) {
        this.list.addRow("Quit to menu", "", {
          kind: "action",
          onActivate: () => this._quitToMenu()
        });
      }
      this.hint.textContent = "Arrows navigate  ·  Enter selects  ·  Esc resumes";
    }
    this.list.paintFocus();
  }
  _refreshVenue() {
    const track = this.ctx.track;
    const session = this.ctx.race?.session;
    this._venueName.textContent = track?.name ?? "";
    if (session) {
      const lapText = session.totalLaps > 0 ? ` · Lap ${session.lap} of ${session.totalLaps}` : "";
      this._venueMeta.textContent = `${session.name}${lapText}`;
    } else {
      this._venueMeta.textContent = track?.country ?? "";
    }
  }
  _handleKey(event) {
    if (!this.isOpen) return;
    let handled = this.list.handleKey(event);
    if (!handled && event.code === "Escape") {
      if (this.screen === SCREEN_SETTINGS) {
        this.screen = SCREEN_PAUSE;
        this.list.focusIndex = 0;
        this._render();
      } else {
        this.close();
      }
      handled = true;
    }
    if (handled) {
      event.preventDefault();
      event.stopPropagation();
    }
  }
  _restart() {
    this.ctx.race?.restart?.();
    this.close();
  }
  _quitToMenu() {
    this._hideOverlay();
    this.ctx.paused = true;
    this.ctx.input?.endFrame?.();
    this.ctx.mainMenu?.show();
  }
  open() {
    if (this.isOpen) return;
    this.isOpen = true;
    this.screen = SCREEN_PAUSE;
    this.list.focusIndex = 0;
    this._refreshVenue();
    this._render();
    this.root.classList.add("is-open");
    this.ctx.paused = true;
    if (this.ctx.input) this.ctx.input.enabled = false;
    document.exitPointerLock?.();
    globalThis.addEventListener("keydown", this._onKeyDown, { capture: true });
  }
  close() {
    if (!this.isOpen) return;
    this._hideOverlay();
    this.ctx.paused = false;
    if (this.ctx.input) this.ctx.input.enabled = true;
    this.ctx.input?.endFrame?.();
  }
  _hideOverlay() {
    this.isOpen = false;
    this.root.classList.remove("is-open");
    globalThis.removeEventListener("keydown", this._onKeyDown, { capture: true });
  }
  toggle() {
    if (this.isOpen) this.close();
    else this.open();
  }
  dispose() {
    this.ctx.events?.off("game:pause", this._onPause);
    globalThis.removeEventListener("keydown", this._onKeyDown, { capture: true });
    this.root.remove();
  }
}
