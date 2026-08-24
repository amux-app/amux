/**
 * macOS traffic-light geometry, shared so the main process and the renderer
 * cannot disagree about where the lights are.
 *
 * The lights sit at a fixed offset from the window's top edge — resizing our own
 * chrome never moves them. Our titlebar cluster is flex-centred inside the strip,
 * so that only lines up while the strip's centre line equals the lights' centre:
 *
 *   TITLEBAR_STRIP_HEIGHT / 2 === TRAFFIC_LIGHT_CENTER_Y
 *
 * Deriving the height from the origin keeps that true by construction, and
 * `titlebar-traffic-light-alignment.test.ts` fails if the strip stops matching.
 */

/** Top-left of the button group, passed to BrowserWindow `trafficLightPosition`. */
export const TRAFFIC_LIGHT_ORIGIN = { x: 18, y: 16 } as const;

/** Measured from a screencapture of the real window: 12px circles on a 23px pitch. */
const TRAFFIC_LIGHT_DIAMETER = 12;
const TRAFFIC_LIGHT_PITCH = 23;
const TRAFFIC_LIGHT_COUNT = 3;

/** Centre line of the lights, measured down from the window's top edge: 22px. */
export const TRAFFIC_LIGHT_CENTER_Y = TRAFFIC_LIGHT_ORIGIN.y + TRAFFIC_LIGHT_DIAMETER / 2;

/** Right edge of the green light: 76px. */
export const TRAFFIC_LIGHT_RIGHT_EDGE =
  TRAFFIC_LIGHT_ORIGIN.x + (TRAFFIC_LIGHT_COUNT - 1) * TRAFFIC_LIGHT_PITCH + TRAFFIC_LIGHT_DIAMETER;

/** Breathing room between the green light and our first control. */
const TRAFFIC_LIGHT_GAP = 10;

/** Left inset our chrome starts at while the lights are on screen: 86px. */
export const TITLEBAR_LIGHTS_GUTTER = TRAFFIC_LIGHT_RIGHT_EDGE + TRAFFIC_LIGHT_GAP;

/** Strip height that puts its flex centre line exactly on the lights: 44px. */
export const TITLEBAR_STRIP_HEIGHT = TRAFFIC_LIGHT_CENTER_Y * 2;
