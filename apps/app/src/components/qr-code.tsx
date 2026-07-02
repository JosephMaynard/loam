import { encodeQR } from '@loam/qr';
import { useMemo } from 'react';
import { StyleSheet, View } from 'react-native';

type QRCodeProps = {
  /** The string to encode (a `WIFI:` payload or a URL). */
  value: string;
  /** Overall pixel size of the code, excluding the quiet-zone border. Default 220. */
  size?: number;
};

// Standard 4-module quiet zone so phone cameras lock on reliably.
const QUIET_ZONE_MODULES = 4;
// QR needs high contrast regardless of app theme — cameras expect dark-on-light.
const DARK = '#000000';
const LIGHT = '#ffffff';

/**
 * Renders a QR code from `@loam/qr` as plain React Native views (no SVG / WebView / native module),
 * so it works in any RN runtime. Each matrix row is one flex row of light/dark cells.
 */
export function QRCode({ value, size = 220 }: QRCodeProps) {
  const rows = useMemo(() => {
    let matrix;

    try {
      matrix = encodeQR(value);
    } catch {
      return null;
    }

    const grid: boolean[][] = [];

    for (let y = 0; y < matrix.size; y += 1) {
      grid.push(matrix.data.slice(y * matrix.size, (y + 1) * matrix.size));
    }

    return { grid, moduleCount: matrix.size };
  }, [value]);

  if (!rows) {
    return null;
  }

  const module = size / rows.moduleCount;
  const padding = module * QUIET_ZONE_MODULES;

  return (
    <View style={[styles.frame, { padding, backgroundColor: LIGHT }]}>
      {rows.grid.map((row, y) => (
        // eslint-disable-next-line react/no-array-index-key -- rows are a fixed positional grid
        <View key={y} style={styles.row}>
          {row.map((filled, x) => (
            <View
              // eslint-disable-next-line react/no-array-index-key -- cells are a fixed positional grid
              key={x}
              style={{ width: module, height: module, backgroundColor: filled ? DARK : LIGHT }}
            />
          ))}
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  frame: {
    borderRadius: 12,
    alignSelf: 'center',
  },
  row: {
    flexDirection: 'row',
  },
});
