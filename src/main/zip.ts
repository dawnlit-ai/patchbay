import { crc32, deflateRawSync } from 'node:zlib';

/**
 * Writing a zip, for a workspace's export. Plain zip with no zip64, which is what
 * Explorer, the Finder and every unzip tool open, so nothing is added to the app
 * for it: zlib already deflates.
 */

/** One file in a zip. */
export interface ZipEntry {
    /** Its path inside the zip, with `/` between folders. */
    name: string;
    data: Buffer;
    modified: Date;
    /** Its permission bits, kept so a script stays runnable when unzipped on a Mac. */
    mode: number;
}

/** Bit 11 of the flags: the name is UTF-8. */
const UTF8 = 0x0800;
const STORED = 0;
const DEFLATED = 8;
/** Version 2.0 of the format, the first with folders and deflate. */
const VERSION = 20;
/** Made by Unix, so unzip tools read the permission bits in the external attributes. */
const MADE_BY_UNIX = (3 << 8) | VERSION;
const REGULAR_FILE = 0o100000;

/** The MS-DOS time and date a zip header holds: local time, to two seconds, from 1980 on. */
function dosTime(when: Date): { time: number; date: number } {
    const d = when.getFullYear() < 1980 ? new Date(1980, 0, 1) : when;
    return {
        time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
        date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
    };
}

/** The entries as one zip, each deflated where that makes it smaller and stored as it is otherwise. */
export function zip(entries: ZipEntry[]): Buffer {
    if (entries.length > 0xffff) throw new Error(`That is ${entries.length} files, more than a zip without zip64 holds.`);
    const records: Buffer[] = [];
    const directory: Buffer[] = [];
    let offset = 0;
    for (const entry of entries) {
        const name = Buffer.from(entry.name, 'utf8');
        const deflated = deflateRawSync(entry.data);
        const stored = deflated.length >= entry.data.length;
        const body = stored ? entry.data : deflated;
        const method = stored ? STORED : DEFLATED;
        const crc = crc32(entry.data);
        const {time, date} = dosTime(entry.modified);
        if (offset + 30 + name.length + body.length > 0xffffffff) {
            throw new Error('That is more than 4 GB, more than a zip without zip64 holds.');
        }

        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(VERSION, 4);
        local.writeUInt16LE(UTF8, 6);
        local.writeUInt16LE(method, 8);
        local.writeUInt16LE(time, 10);
        local.writeUInt16LE(date, 12);
        local.writeUInt32LE(crc, 14);
        local.writeUInt32LE(body.length, 18);
        local.writeUInt32LE(entry.data.length, 22);
        local.writeUInt16LE(name.length, 26);
        records.push(local, name, body);

        const central = Buffer.alloc(46);
        central.writeUInt32LE(0x02014b50, 0);
        central.writeUInt16LE(MADE_BY_UNIX, 4);
        central.writeUInt16LE(VERSION, 6);
        central.writeUInt16LE(UTF8, 8);
        central.writeUInt16LE(method, 10);
        central.writeUInt16LE(time, 12);
        central.writeUInt16LE(date, 14);
        central.writeUInt32LE(crc, 16);
        central.writeUInt32LE(body.length, 20);
        central.writeUInt32LE(entry.data.length, 24);
        central.writeUInt16LE(name.length, 28);
        central.writeUInt32LE(((REGULAR_FILE | (entry.mode & 0o777)) << 16) >>> 0, 38);
        central.writeUInt32LE(offset, 42);
        directory.push(central, name);

        offset += 30 + name.length + body.length;
    }
    const listing = Buffer.concat(directory);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(entries.length, 8);
    end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(listing.length, 12);
    end.writeUInt32LE(offset, 16);
    return Buffer.concat([...records, listing, end]);
}
