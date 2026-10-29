/** Reviewed 2026-10-25 against the exact official release; never resolve a floating channel. */
export const K3S_VERSION = 'v1.35.9+k3s1';
export const K3S_ASSET_SOURCE =
  'https://api.github.com/repos/k3s-io/k3s/releases/tags/v1.35.9%2Bk3s1';

export const k3sAssets = {
  arm64: {
    binary: {
      url: 'https://github.com/k3s-io/k3s/releases/download/v1.35.9%2Bk3s1/k3s-arm64',
      apiUrl: 'https://api.github.com/repos/k3s-io/k3s/releases/assets/601313455',
      sha256: '6176dd12c512e177af998e6035920f6283c5fdbd5adfdff85c103a7fdf2a00b5',
      bytes: 70779042,
    },
    images: {
      url: 'https://github.com/k3s-io/k3s/releases/download/v1.35.9%2Bk3s1/k3s-airgap-images-arm64.tar.zst',
      apiUrl: 'https://api.github.com/repos/k3s-io/k3s/releases/assets/601313433',
      sha256: '2c7a2347a7bf7606a40b6d2a8e2f350dfdc47f552c059f4594491934c25a6780',
      bytes: 176489633,
    },
  },
  amd64: {
    binary: {
      url: 'https://github.com/k3s-io/k3s/releases/download/v1.35.9%2Bk3s1/k3s',
      apiUrl: 'https://api.github.com/repos/k3s-io/k3s/releases/assets/601313115',
      sha256: '897acb21cca57d477a211102251a6591450ce767344a9faaa121a1007ca9fa9a',
      bytes: 78237858,
    },
    images: {
      url: 'https://github.com/k3s-io/k3s/releases/download/v1.35.9%2Bk3s1/k3s-airgap-images-amd64.tar.zst',
      apiUrl: 'https://api.github.com/repos/k3s-io/k3s/releases/assets/601313114',
      sha256: '7f1cbfea56d38f5e69aec13500a89290119096cc2f5a6d4f542e5f26599977d0',
      bytes: 194444185,
    },
  },
} as const;
