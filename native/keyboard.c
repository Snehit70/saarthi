/* One bounded keyboard action on an explicit private Wayland socket. After
 * writing its receipt this client retains the device, without accepting any
 * more commands, until the next action replaces it or the desktop stops. */
#define _GNU_SOURCE
#include "virtual-keyboard-unstable-v1-client-protocol.h"
#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <time.h>
#include <unistd.h>
#include <wayland-client.h>
#include <xkbcommon/xkbcommon.h>
static struct zwp_virtual_keyboard_manager_v1 *manager;
static struct wl_seat *seat;
static int seats;
static void global(void *data, struct wl_registry *registry, uint32_t name,
                   const char *interface, uint32_t version) {
  (void)data;
  (void)version;
  if (!strcmp(interface, "zwp_virtual_keyboard_manager_v1"))
    manager = wl_registry_bind(registry, name,
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
  return wl_display_roundtrip(display) < 0;
}
static int number(const char *value, int min, int max) {
  char *end;
  long n = strtol(value, &end, 10);
  if (!*value || *end || n < min || n > max)
    exit(2);
  return (int)n;
}
static size_t decode(const unsigned char *bytes, size_t size,
                     uint32_t *points) {
  size_t count = 0;
  for (size_t i = 0; i < size;) {
    uint32_t c = bytes[i++], minimum = 0;
    int extra = 0;
    if (c >= 0xc2 && c <= 0xdf) {
      c &= 31;
      extra = 1;
      minimum = 0x80;
    } else if (c >= 0xe0 && c <= 0xef) {
      c &= 15;
      extra = 2;
      minimum = 0x800;
    } else if (c >= 0xf0 && c <= 0xf4) {
      c &= 7;
      extra = 3;
      minimum = 0x10000;
    } else if (c >= 0x80)
      exit(2);
    if (i + (size_t)extra > size)
      exit(2);
    while (extra--) {
      if ((bytes[i] & 0xc0) != 0x80)
        exit(2);
      c = (c << 6) | (bytes[i++] & 63);
    }
    if (c < minimum || c < 32 || (c >= 127 && c <= 159) ||
        (c >= 0xd800 && c <= 0xdfff) || c > 0x10ffff || count >= 4000)
      exit(2);
    points[count++] = c;
  }
  if (!count)
    exit(2);
  return count;
}
/* Chromium uses physical meanings for control codes even with printable
 * keysyms. Literal text only uses printable evdev codes, in bounded maps. */
static const uint32_t text_codes[] = {
    2,  3,  4,  5,  6,  7,  8,  9,  10, 11, 12, 13, 16, 17, 18, 19,
    20, 21, 22, 23, 24, 25, 26, 27, 30, 31, 32, 33, 34, 35, 36, 37,
    38, 39, 40, 41, 43, 44, 45, 46, 47, 48, 49, 50, 51, 52, 53, 57};
#define TEXT_CODES (sizeof(text_codes) / sizeof(text_codes[0]))
static char *text_keymap(const uint32_t *points, size_t count) {
  char *text = NULL;
  size_t size = 0;
  FILE *stream = open_memstream(&text, &size);
  if (!stream)
    return NULL;
  fprintf(stream, "xkb_keymap { xkb_keycodes { minimum=9; maximum=%zu;",
          (size_t)65);
  for (size_t i = 0; i < count; i++)
    fprintf(stream, "<K%03zX>=%zu;", i, (size_t)text_codes[i] + 8);
  fputs("}; xkb_types { type \"ONE_LEVEL\" { modifiers=None; map[None]=Level1; "
        "}; }; xkb_compatibility {}; xkb_symbols {",
        stream);
  for (size_t i = 0; i < count; i++)
    fprintf(stream, "key <K%03zX> { type=\"ONE_LEVEL\", [ U%04X ] };", i,
            points[i]);
  fputs("}; };", stream);
  if (fclose(stream)) {
    free(text);
    return NULL;
  }
  return text;
}
static int upload(struct wl_display *display,
                  struct zwp_virtual_keyboard_v1 *keyboard, char *text) {
  if (!text)
    return 1;
  size_t size = strlen(text) + 1;
  int fd = memfd_create("saarthi-private-keymap", MFD_CLOEXEC);
  if (fd < 0 || ftruncate(fd, (off_t)size))
    return 1;
  size_t written = 0;
  while (written < size) {
    ssize_t n = write(fd, text + written, size - written);
    if (n <= 0)
      return 1;
    written += (size_t)n;
  }
  zwp_virtual_keyboard_v1_keymap(keyboard, WL_KEYBOARD_KEYMAP_FORMAT_XKB_V1, fd,
                                 (uint32_t)size);
  int result = sync_display(display);
  close(fd);
  free(text);
  return result;
}
int main(int argc, char **argv) {
  if (argc < 4 || argv[1][0] != '/' || argv[2][0] != '/')
    return 2;
  int typing = !strcmp(argv[3], "type"), code = 0, mask = 0;
  size_t count = 0;
  uint32_t points[4000];
  char *text = NULL;
  if (typing) {
    if (argc != 4)
      return 2;
    unsigned char bytes[16001];
    size_t size = fread(bytes, 1, sizeof(bytes), stdin);
    if (ferror(stdin) || size == sizeof(bytes))
      return 2;
    count = decode(bytes, size, points);
    text = text_keymap(points, count < TEXT_CODES ? count : TEXT_CODES);
  } else {
    if (argc != 6 || strcmp(argv[3], "key"))
      return 2;
    code = number(argv[4], 1, 255);
    mask = number(argv[5], 0, 15);
    struct xkb_context *context = xkb_context_new(XKB_CONTEXT_NO_FLAGS);
    if (!context)
      return 3;
    const struct xkb_rule_names names = {.layout = "us", .options = ""};
    struct xkb_keymap *keymap =
        xkb_keymap_new_from_names(context, &names, XKB_KEYMAP_COMPILE_NO_FLAGS);
    if (!keymap)
      return 3;
    text = xkb_keymap_get_as_string(keymap, XKB_KEYMAP_FORMAT_TEXT_V1);
    xkb_keymap_unref(keymap);
    xkb_context_unref(context);
  }
  if (!text)
    return 3;
  struct wl_display *display = wl_display_connect(argv[1]);
  if (!display)
    return 3;
  struct wl_registry *registry = wl_display_get_registry(display);
  wl_registry_add_listener(registry, &listener, NULL);
  if (sync_display(display) || !manager || !seat || seats != 1)
    return 3;
  struct zwp_virtual_keyboard_v1 *keyboard =
      zwp_virtual_keyboard_manager_v1_create_virtual_keyboard(manager, seat);
  if (upload(display, keyboard, text))
    return 3;
  pause_ms(50);
  uint32_t mods = ((mask & 1) ? (1U << 2) : 0) | ((mask & 2) ? (1U << 3) : 0) |
                  ((mask & 4) ? 1U : 0) | ((mask & 8) ? (1U << 6) : 0);
  zwp_virtual_keyboard_v1_modifiers(keyboard, mods, 0, 0, 0);
  if (sync_display(display))
    return 3;
  size_t keys = typing ? count : 1;
  for (size_t i = 0; i < keys; i++) {
    if (typing && i > 0 && i % TEXT_CODES == 0) {
      size_t remaining = count - i;
      if (upload(display, keyboard,
                 text_keymap(points + i,
                             remaining < TEXT_CODES ? remaining : TEXT_CODES)))
        return 3;
    }
    uint32_t key = typing ? text_codes[i % TEXT_CODES] : (uint32_t)code;
    zwp_virtual_keyboard_v1_key(keyboard, now(), key,
                                WL_KEYBOARD_KEY_STATE_PRESSED);
    if (sync_display(display))
      return 3;
    pause_ms(typing ? 1 : 40);
    zwp_virtual_keyboard_v1_key(keyboard, now(), key,
                                WL_KEYBOARD_KEY_STATE_RELEASED);
    if (sync_display(display))
      return 3;
  }
  zwp_virtual_keyboard_v1_modifiers(keyboard, 0, 0, 0, 0);
  if (sync_display(display))
    return 3;
  pause_ms(50);
  char *temporary = NULL;
  if (asprintf(&temporary, "%s.tmp", argv[2]) < 0)
    return 3;
  int receipt = open(
      temporary, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);
  if (receipt < 0)
    return 3;
  if (write(receipt, "{\"complete\":true}", 17) != 17 || fsync(receipt))
    return 3;
  close(receipt);
  if (rename(temporary, argv[2]))
    return 3;
  free(temporary);
  while (wl_display_dispatch(display) >= 0) {
  }
  wl_display_disconnect(display);
  return 0;
}
