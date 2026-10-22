/* Virtual pointer for one explicit private Wayland socket. No discovery,
 * host fallback, uinput, or shell interface exists here. */
#define _GNU_SOURCE
#include "virtual-keyboard-unstable-v1-client-protocol.h"
#include "wlr-virtual-pointer-unstable-v1-client-protocol.h"
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <time.h>
#include <unistd.h>
#include <wayland-client.h>
#include <xkbcommon/xkbcommon.h>
static struct zwlr_virtual_pointer_manager_v1 *manager;
static struct zwp_virtual_keyboard_manager_v1 *keyboards;
static struct wl_seat *seat;
static int seats;
static void global(void *data, struct wl_registry *registry, uint32_t name,
                   const char *interface, uint32_t version) {
  (void)data;
  if (!strcmp(interface, "zwlr_virtual_pointer_manager_v1"))
    manager = wl_registry_bind(registry, name,
                               &zwlr_virtual_pointer_manager_v1_interface,
                               version > 2 ? 2 : version);
  else if (!strcmp(interface, "zwp_virtual_keyboard_manager_v1"))
    keyboards = wl_registry_bind(registry, name,
                                 &zwp_virtual_keyboard_manager_v1_interface, 1);
  else if (!strcmp(interface, "wl_seat")) {
    seats++;
    if (!seat)
      seat = wl_registry_bind(registry, name, &wl_seat_interface, 1);
  }
}
static void removed(void *data, struct wl_registry *registry, uint32_t name) {
  (void)data;
  (void)registry;
  (void)name;
}
static const struct wl_registry_listener listener = {.global = global,
                                                     .global_remove = removed};
static int number(const char *value, int min, int max) {
  char *end = NULL;
  long n = strtol(value, &end, 10);
  if (!value[0] || !end || *end || n < min || n > max) {
    fputs("Invalid pointer argument\n", stderr);
    exit(2);
  }
  return (int)n;
}
static uint32_t now(void) {
  struct timespec ts;
  clock_gettime(CLOCK_MONOTONIC, &ts);
  return (uint32_t)((uint64_t)ts.tv_sec * 1000 + ts.tv_nsec / 1000000);
}
static void pause_ms(int ms) {
  struct timespec ts = {.tv_sec = ms / 1000, .tv_nsec = (ms % 1000) * 1000000L};
  nanosleep(&ts, NULL);
}
static int sync_display(struct wl_display *display) {
  return wl_display_roundtrip(display) < 0 ? 1 : 0;
}
static void move(struct zwlr_virtual_pointer_v1 *pointer, int x, int y,
                 int width, int height) {
  zwlr_virtual_pointer_v1_motion_absolute(pointer, now(), (uint32_t)x,
                                          (uint32_t)y, (uint32_t)width,
                                          (uint32_t)height);
  zwlr_virtual_pointer_v1_frame(pointer);
}
static struct zwp_virtual_keyboard_v1 *
create_keyboard(struct wl_display *display) {
  struct xkb_context *context = xkb_context_new(XKB_CONTEXT_NO_FLAGS);
  if (!context)
    return NULL;
  const struct xkb_rule_names names = {.layout = "us", .options = ""};
  struct xkb_keymap *keymap =
      xkb_keymap_new_from_names(context, &names, XKB_KEYMAP_COMPILE_NO_FLAGS);
  if (!keymap)
    return NULL;
  char *text = xkb_keymap_get_as_string(keymap, XKB_KEYMAP_FORMAT_TEXT_V1);
  if (!text)
    return NULL;
  size_t size = strlen(text) + 1;
  int fd = memfd_create("saarthi-private-keymap", MFD_CLOEXEC);
  if (fd < 0 || ftruncate(fd, (off_t)size) < 0)
    return NULL;
  size_t written = 0;
  while (written < size) {
    ssize_t n = write(fd, text + written, size - written);
    if (n <= 0)
      return NULL;
    written += (size_t)n;
  }
  struct zwp_virtual_keyboard_v1 *keyboard =
      zwp_virtual_keyboard_manager_v1_create_virtual_keyboard(keyboards, seat);
  zwp_virtual_keyboard_v1_keymap(keyboard, WL_KEYBOARD_KEYMAP_FORMAT_XKB_V1, fd,
                                 (uint32_t)size);
  if (sync_display(display))
    return NULL;
  close(fd);
  free(text);
  xkb_keymap_unref(keymap);
  xkb_context_unref(context);
  return keyboard;
}
int main(int argc, char **argv) {
  if (argc < 7 || argv[1][0] != '/') {
    fputs("An explicit absolute private socket is required\n", stderr);
    return 2;
  }
  int width = number(argv[2], 320, 3840), height = number(argv[3], 240, 2160);
  const char *action = argv[4];
  int x = number(argv[5], 0, width - 1), y = number(argv[6], 0, height - 1);
  int button = 272, count = 1, x2 = x, y2 = y, duration = 200, steps = 0;
  uint32_t axis = WL_POINTER_AXIS_VERTICAL_SCROLL;
  if (!strcmp(action, "move") || !strcmp(action, "keepalive")) {
    if (argc != 7)
      return 2;
  } else if (!strcmp(action, "click")) {
    if (argc != 9)
      return 2;
    button = number(argv[7], 272, 274);
    count = number(argv[8], 1, 2);
  } else if (!strcmp(action, "drag")) {
    if (argc != 10)
      return 2;
    x2 = number(argv[7], 0, width - 1);
    y2 = number(argv[8], 0, height - 1);
    duration = number(argv[9], 100, 2000);
  } else if (!strcmp(action, "scroll")) {
    if (argc != 9)
      return 2;
    steps = number(argv[8], 1, 20);
    if (!strcmp(argv[7], "up"))
      steps = -steps;
    else if (!strcmp(argv[7], "left")) {
      axis = WL_POINTER_AXIS_HORIZONTAL_SCROLL;
      steps = -steps;
    } else if (!strcmp(argv[7], "right"))
      axis = WL_POINTER_AXIS_HORIZONTAL_SCROLL;
    else if (strcmp(argv[7], "down"))
      return 2;
  } else
    return 2;
  struct wl_display *display = wl_display_connect(argv[1]);
  if (!display)
    return 3;
  struct wl_registry *registry = wl_display_get_registry(display);
  wl_registry_add_listener(registry, &listener, NULL);
  if (sync_display(display) || !manager || !seat || seats != 1)
    return 3;
  struct zwlr_virtual_pointer_v1 *pointer =
      zwlr_virtual_pointer_manager_v1_create_virtual_pointer(manager, seat);
  if (!strcmp(action, "keepalive")) {
    if (!keyboards)
      return 3;
    struct zwp_virtual_keyboard_v1 *keyboard = create_keyboard(display);
    if (!keyboard)
      return 3;
    move(pointer, x, y, width, height);
    if (sync_display(display))
      return 3;
    while (wl_display_dispatch(display) >= 0) {
    }
    wl_display_disconnect(display);
    return 0;
  }
  if (sync_display(display))
    return 3;
  /* Give toolkit clients a bounded interval to bind the new pointer. */
  pause_ms(50);
  if (sync_display(display))
    return 3;
  move(pointer, x, y, width, height);
  if (sync_display(display))
    return 3;
  pause_ms(30);
  if (!strcmp(action, "click"))
    for (int i = 0; i < count; i++) {
      zwlr_virtual_pointer_v1_button(pointer, now(), (uint32_t)button,
                                     WL_POINTER_BUTTON_STATE_PRESSED);
      zwlr_virtual_pointer_v1_frame(pointer);
      if (sync_display(display))
        return 3;
      pause_ms(25);
      zwlr_virtual_pointer_v1_button(pointer, now(), (uint32_t)button,
                                     WL_POINTER_BUTTON_STATE_RELEASED);
      zwlr_virtual_pointer_v1_frame(pointer);
      if (sync_display(display))
        return 3;
      pause_ms(30);
    }
  else if (!strcmp(action, "drag")) {
    zwlr_virtual_pointer_v1_button(pointer, now(), 272,
                                   WL_POINTER_BUTTON_STATE_PRESSED);
    zwlr_virtual_pointer_v1_frame(pointer);
    if (sync_display(display))
      return 3;
    for (int i = 1; i <= 20; i++) {
      pause_ms(duration / 20);
      move(pointer, x + (x2 - x) * i / 20, y + (y2 - y) * i / 20, width,
           height);
      if (sync_display(display))
        return 3;
    }
    zwlr_virtual_pointer_v1_button(pointer, now(), 272,
                                   WL_POINTER_BUTTON_STATE_RELEASED);
    zwlr_virtual_pointer_v1_frame(pointer);
  } else if (!strcmp(action, "scroll")) {
    zwlr_virtual_pointer_v1_axis_source(pointer, WL_POINTER_AXIS_SOURCE_WHEEL);
    zwlr_virtual_pointer_v1_axis_discrete(pointer, now(), axis,
                                          wl_fixed_from_int(steps * 15), steps);
    zwlr_virtual_pointer_v1_frame(pointer);
  }
  if (sync_display(display))
    return 3;
  pause_ms(30);
  zwlr_virtual_pointer_v1_destroy(pointer);
  if (sync_display(display))
    return 3;
  wl_display_disconnect(display);
  return 0;
}
