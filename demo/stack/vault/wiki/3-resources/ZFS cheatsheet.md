---
title: "ZFS cheatsheet"
type: resource
area: homelab
tags: [zfs, storage]
updated: 2026-11-01
status: evergreen
---
# ZFS cheatsheet

```
zpool status -x
zpool scrub tank
zpool replace tank sdb sdf
```

Scrub weekly. Replace a disk as soon as it throws checksum errors.
