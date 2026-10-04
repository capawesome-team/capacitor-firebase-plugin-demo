import { Platform } from '@ionic/angular/lazy';

export const createPlatformSpy = (): jasmine.SpyObj<Platform> =>
  jasmine.createSpyObj('Platform', {
    is: false,
    ready: Promise.resolve(),
  });
