export type QRVersion = 4 | 5 | 6;

export type QRMatrix = {
  version: QRVersion;
  size: number;
  data: boolean[];
};

export type InternalMatrix = {
  size: number;
  modules: boolean[][];
  reserved: boolean[][];
};

export type EncodeOptions = {
  version?: QRVersion;
};
