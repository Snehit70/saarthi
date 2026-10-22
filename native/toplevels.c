/* Map compositor window addresses to stable capture identifiers. No focus or
 * input requests exist in this helper. Protocol licenses are in protocols/. */
#define _POSIX_C_SOURCE 200809L
#include <inttypes.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <wayland-client.h>
#include "ext-foreign-toplevel-list-v1-client-protocol.h"
#include "hyprland-toplevel-mapping-v1-client-protocol.h"

struct entry {
    struct ext_foreign_toplevel_handle_v1 *handle;
    struct hyprland_toplevel_window_mapping_handle_v1 *mapping;
    uint64_t address;
    char *identifier;
    bool closed;
};
static struct entry entries[4096];
static size_t count;
static bool overflow;
static struct ext_foreign_toplevel_list_v1 *list;
static struct hyprland_toplevel_mapping_manager_v1 *mapper;

static void closed(void *data, struct ext_foreign_toplevel_handle_v1 *handle) {
    (void)handle;
    ((struct entry *)data)->closed = true;
}
static void done(void *data, struct ext_foreign_toplevel_handle_v1 *handle) {
    (void)data; (void)handle;
}
static void ignored_string(void *data, struct ext_foreign_toplevel_handle_v1 *handle, const char *value) {
    (void)data; (void)handle; (void)value;
}
static void identifier(void *data, struct ext_foreign_toplevel_handle_v1 *handle, const char *value) {
    (void)handle;
    struct entry *entry = data;
    free(entry->identifier);
    entry->identifier = strlen(value) <= 1024 ? strdup(value) : NULL;
}
static const struct ext_foreign_toplevel_handle_v1_listener handle_listener = {
    .closed = closed, .done = done, .title = ignored_string,
    .app_id = ignored_string, .identifier = identifier,
};
static void toplevel(void *data, struct ext_foreign_toplevel_list_v1 *manager,
                     struct ext_foreign_toplevel_handle_v1 *handle) {
    (void)data; (void)manager;
    if (count == sizeof(entries) / sizeof(entries[0])) {
        overflow = true;
        ext_foreign_toplevel_handle_v1_destroy(handle);
        return;
    }
    struct entry *entry = &entries[count++];
    entry->handle = handle;
    ext_foreign_toplevel_handle_v1_add_listener(handle, &handle_listener, entry);
}
static void finished(void *data, struct ext_foreign_toplevel_list_v1 *manager) {
    (void)data; (void)manager;
}
static const struct ext_foreign_toplevel_list_v1_listener list_listener = {
    .toplevel = toplevel, .finished = finished,
};
static void address(void *data, struct hyprland_toplevel_window_mapping_handle_v1 *handle,
                    uint32_t high, uint32_t low) {
    (void)handle;
    ((struct entry *)data)->address = ((uint64_t)high << 32) | low;
}
static void failed(void *data, struct hyprland_toplevel_window_mapping_handle_v1 *handle) {
    (void)data; (void)handle;
}
static const struct hyprland_toplevel_window_mapping_handle_v1_listener mapping_listener = {
    .window_address = address, .failed = failed,
};
static void global(void *data, struct wl_registry *registry, uint32_t name,
                   const char *interface, uint32_t version) {
    (void)data; (void)version;
    if (!strcmp(interface, "ext_foreign_toplevel_list_v1")) {
        list = wl_registry_bind(registry, name, &ext_foreign_toplevel_list_v1_interface, 1);
        ext_foreign_toplevel_list_v1_add_listener(list, &list_listener, NULL);
    } else if (!strcmp(interface, "hyprland_toplevel_mapping_manager_v1")) {
        mapper = wl_registry_bind(registry, name, &hyprland_toplevel_mapping_manager_v1_interface, 1);
    }
}
static void global_remove(void *data, struct wl_registry *registry, uint32_t name) {
    (void)data; (void)registry; (void)name;
}
static const struct wl_registry_listener registry_listener = {.global = global, .global_remove = global_remove};
static void json_string(const char *value) {
    putchar('"');
    for (const unsigned char *p = (const unsigned char *)value; *p; ++p) {
        if (*p == '"' || *p == '\\') { putchar('\\'); putchar(*p); }
        else if (*p < 0x20) printf("\\u%04x", *p);
        else putchar(*p);
    }
    putchar('"');
}
int main(void) {
    struct wl_display *display = wl_display_connect(NULL);
    if (!display) { fputs("Cannot connect to the Wayland session\n", stderr); return 2; }
    struct wl_registry *registry = wl_display_get_registry(display);
    wl_registry_add_listener(registry, &registry_listener, NULL);
    if (wl_display_roundtrip(display) < 0 || !list || !mapper || wl_display_roundtrip(display) < 0) {
        fputs("Compositor lacks foreign toplevel mapping support\n", stderr); return 2;
    }
    /* The list is complete at this sync. Map precisely these handles, then
     * wait for their replies; no timing sleeps or truncated pointer ids. */
    size_t mapped_count = count;
    for (size_t i = 0; i < mapped_count; ++i) {
        if (entries[i].closed) continue;
        entries[i].mapping = hyprland_toplevel_mapping_manager_v1_get_window_for_toplevel(mapper, entries[i].handle);
        hyprland_toplevel_window_mapping_handle_v1_add_listener(entries[i].mapping, &mapping_listener, &entries[i]);
    }
    if (wl_display_roundtrip(display) < 0 || overflow) {
        fputs("Window mapping failed or exceeded its bounds\n", stderr); return 2;
    }
    bool first = true;
    putchar('[');
    for (size_t i = 0; i < mapped_count; ++i) {
        struct entry *entry = &entries[i];
        if (entry->closed || !entry->address || !entry->identifier) continue;
        if (!first) putchar(',');
        first = false;
        printf("{\"windowId\":\"0x%" PRIx64 "\",\"identifier\":", entry->address);
        json_string(entry->identifier);
        putchar('}');
    }
    puts("]");
    for (size_t i = 0; i < count; ++i) free(entries[i].identifier);
    wl_display_disconnect(display);
    return 0;
}
