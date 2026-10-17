# Changes that we need to do in the app:

1. No full screen in windows and scrollbars showing in the side view in AI race.
2. Multiplayer (Already in making)
3. Different types of maps like F1, mountains, city etc.
4. Different difficulty modes (Easy, medium, hard):
   - In easy, the AI cars are easily beatable (AI is given freedom to choose between 0x - 1x throttle) and no fight mode. Its the easiest mode (duh).
   - In medium, the AI cars are slighly harder to beat (AI is given freedom to choose between 0.75x - 1x throttle) and variable fight mode.
   - In hard mode, which is currenly implemented, its full throttle and full fight mode.

> Need inspiration on what can be improved in easy/medium/hard mode.

1. Cars going underground when overturned, i think its a positioning fix.
2. Better animations when opening app, navigating, results and menu, while creating a better design (UI/UX)
3. Description error messages or window messages instead of "mainview"
4. ~~Multiple cars instead of just the M3, each with different physics and design.~~ DONE (car registry in `src/mainview/constants/cars.ts`: M3, R8, G 63, Urus — see "HOW TO ADD A CAR" there).
5. Maps difficulty modes as well (based on factors such as elevation, curves, vegetation, blockers etc)
6. Camera fix on the car
7. Rewind 5 seconds (like forza horizon)
8. Lights on the car, weather, time of day etc (environmental changes, for later)
9. ~~Possibly AWD, RWD, 2WD, FWD etc?~~ DONE (`drivetrain.frontTorqueSplit` per car: M3 RWD 0/100, R8 30/70, G 63 40/60, Urus 38/62).
10. Lookout for real car physics engine that can be used here.
11. Add dyno mode.
