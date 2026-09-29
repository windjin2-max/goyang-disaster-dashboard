-- Date-only analysis filters represent local calendar dates in Goyang.
-- The existing SQL function casts those dates to timestamptz, so evaluate
-- them in Korea Standard Time to include the intended observation hours.
alter function public.get_historical_analysis(date, date)
  set timezone = 'Asia/Seoul';
