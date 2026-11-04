import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { Profile, Strategy, VerifyCallback } from 'passport-google-oauth20';
import { Request } from 'express';
import { AppConfigService } from 'src/config/config.service';

@Injectable()
export class GoogleStrategy extends PassportStrategy(Strategy, 'google') {
  constructor(config: AppConfigService) {
    super({
      clientID: config.auth.googleClientId,
      clientSecret: config.auth.googleClientSecret,
      callbackURL: config.auth.googleCallbackUrl,
      scope: ['profile', 'email'],
    });
  }

  async validate(
    _accessToken: string,
    _refreshToken: string,
    profile: Profile,
    done: VerifyCallback,
  ): Promise<any> {
    const { id, name, emails, photos } = profile;
    const email = emails?.[0];

    // An unverified Google address must never be treated as proof of ownership:
    // forceLogin looks accounts up by email, so accepting one would allow
    // taking over an existing password account.
    if (email?.verified && name && photos?.[0]) {
      const user = {
        provider: 'google',
        providerId: id,
        email: email.value,
        name: `${name.givenName} ${name.familyName}`,
        picture: photos[0].value,
      };

      done(null, user);
      return;
    }
    done(null, false);
  }
}

export interface GoogleAuthenticatedRequest extends Request {
  user: {
    provider: 'google';
    providerId: string;
    email: string;
    name: string;
    picture: string;
  };
}
