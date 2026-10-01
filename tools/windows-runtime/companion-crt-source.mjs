// Microsoft x64 Minimum14.44.35211: fixed public Redist, data-only extraction.
export const CRT_SOURCE = Object.freeze({
  version: "14.44.35211.0",
  url: "https://download.visualstudio.microsoft.com/download/pr/bd1c8d9d-ba95-4eee-bc6e-df1fcc876373/CC0FF0EB1DC3F5188AE6300FAEF32BF5BEEBA4BDD6E8E445A9184072096B713B/VC_redist.x64.exe",
  sha256: "cc0ff0eb1dc3f5188ae6300faef32bf5beeba4bdd6e8e445a9184072096b713b",
  size: 25635768,
  format: "microsoft-redist-exe-cab",
});

export const CRT_CABS = Object.freeze(
  Object.fromEntries(
    Object.entries({
      ui: {
        offset: 479744,
        size: 195988,
        sha256: "2f57cf2cd504bd100c9222bb123b9c3a40802cca73e89ca05c97885d91be3a78",
      },
      payload: {
        offset: 686152,
        size: 24939223,
        sha256: "468f1264d50b9e3b9d309ab9e13c02ff379fd95a2837383bf65c9616583013d6",
      },
      minimum: {
        file_id: "a12",
        size: 987836,
        cabinet_size: 977468,
        sha256: "640aa6c516c72444523b8fbe034db46ff4e118ed02705340e3ccb62d426ff040",
      },
    }).map(([key, value]) => [key, Object.freeze(value)]),
  ),
);

export const CRT_DLLS = Object.freeze(
  [
    {
      name: "concrt140.dll",
      file_id: "concrt140.dll_amd64",
      size: 324208,
      sha256: "2405355f0a58067b258f8df33c327e3a3d716eaac5a3a5aebb757842d85bd376",
    },
    {
      name: "msvcp140.dll",
      file_id: "msvcp140.dll_amd64",
      size: 557728,
      sha256: "0f885b509a685d2bbfa652fed26b5fb31d88fbdab0a978c641d1c7b8aa460aa9",
    },
    {
      name: "msvcp140_1.dll",
      file_id: "msvcp140_1.dll_amd64",
      size: 35952,
      sha256: "bfad5aef4c63a669e3c140655cdfdf395b6c979b400a447bd5dcb65ed8826c3d",
    },
    {
      name: "msvcp140_2.dll",
      file_id: "msvcp140_2.dll_amd64",
      size: 280200,
      sha256: "3ea06f0ee098b4823cb79599df3780e7f23cce52c19aac31d2a0d47efe33a5e9",
    },
    {
      name: "msvcp140_atomic_wait.dll",
      file_id: "msvcp140_atomic_wait.dll_amd64",
      size: 50304,
      sha256: "640b2aefced484d0368eea5bdd06addd0658a3a70a49256e560d6923b404a479",
    },
    {
      name: "msvcp140_codecvt_ids.dll",
      file_id: "msvcp140_codecvt_ids.dll_amd64",
      size: 31872,
      sha256: "f2069a52880ec885ee7f0511186100eb7fada0411a2b4948fafea7735b878a18",
    },
    {
      name: "vcamp140.dll",
      file_id: "vcamp140.dll_amd64",
      size: 418944,
      sha256: "52af68f35476bd03d7b97752b01bef358ffdda568d150057d6ce809f77c4f704",
    },
    {
      name: "vccorlib140.dll",
      file_id: "vccorlib140.dll_amd64",
      size: 352384,
      sha256: "19839407c3fdbc824e5bce189bf68ddf8097f12ec28b757797ffa0415c144ddd",
    },
    {
      name: "vcomp140.dll",
      file_id: "vcomp140.dll_amd64",
      size: 193152,
      sha256: "55aba23cdcd6484fbb06f4155b8ca75adfce7a881f10afd0c49457165e677164",
    },
    {
      name: "vcruntime140.dll",
      file_id: "vcruntime140.dll_amd64",
      size: 124544,
      sha256: "d5e4d9a3e835fa679450145d6a7d94e36573a509317111904d9b3712c30d9066",
    },
    {
      name: "vcruntime140_1.dll",
      file_id: "vcruntime140_1.dll_amd64",
      size: 49792,
      sha256: "1f2d41c4aa5db0bc33ebf7b66d72943a817d7ce6cbe880502a9403823633093f",
    },
    {
      name: "vcruntime140_threads.dll",
      file_id: "vcruntime140_threads.dll_amd64",
      size: 38528,
      sha256: "219915cf20822f34d5e7c1fdd4e21ae7f3396881096c51036225fb8f84b47afa",
    },
  ].map((value) => Object.freeze(value)),
);

export const CRT_LICENSE = Object.freeze({
  file_id: "u4",
  size: 9235,
  sha256: "8099dc3cf9502c335da829e5c755948a12e3e6de490eb492a99deb673d883d8b",
});
