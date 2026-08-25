# Vendored dependency notice

`pytypedstream==0.1.0` is vendored under `vendor/pytypedstream-0.1.0/` for
reading macOS Messages `attributedBody` values. It is licensed under
LGPL-3.0-or-later. The complete upstream license texts are retained as
`pytypedstream-0.1.0.dist-info/COPYING.txt` and
`pytypedstream-0.1.0.dist-info/COPYING.LESSER.txt`.

The bridge imports only `typedstream.stream.TypedStreamReader` and primitive
low-level event classes. It does not invoke the package's generic unarchiver,
load Python objects, or execute serialized data. Upgrade this vendor only with
a reviewed version, its license and a refreshed hash manifest.
