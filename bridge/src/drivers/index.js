// The device kinds this bridge can talk to, by the driver name CommunityOS gives each device.
import { HikvisionDriver } from './hikvision/driver.js';

export const DRIVERS = { 'hikvision-isapi': HikvisionDriver };
