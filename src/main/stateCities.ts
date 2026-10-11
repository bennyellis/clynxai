// The 10 most populous cities of each US state the app can search (the 48 in Config's state picker), biggest first (2020 Census
// order, give or take close neighbours). When a state is searched, Clynx looks in these: a fixed list rather than asking the AI
// for "the big cities" each time, which gave a different answer from run to run, sometimes named small famous towns instead of
// big ones, and needed OpenAI credits. Names are what Facebook Marketplace's own location box recognizes.
import { US_STATE_ABBREVIATIONS } from "./usStates.js";

export const TOP_CITIES_BY_STATE: Record<string, string[]> = {
  Alabama: ["Huntsville", "Birmingham", "Montgomery", "Mobile", "Tuscaloosa", "Hoover", "Auburn", "Dothan", "Decatur", "Madison"],
  Arizona: ["Phoenix", "Tucson", "Mesa", "Chandler", "Gilbert", "Glendale", "Scottsdale", "Peoria", "Tempe", "Surprise"],
  Arkansas: ["Little Rock", "Fayetteville", "Fort Smith", "Springdale", "Jonesboro", "North Little Rock", "Conway", "Rogers", "Pine Bluff", "Bentonville"],
  California: ["Los Angeles", "San Diego", "San Jose", "San Francisco", "Fresno", "Sacramento", "Long Beach", "Oakland", "Bakersfield", "Anaheim"],
  Colorado: ["Denver", "Colorado Springs", "Aurora", "Fort Collins", "Lakewood", "Thornton", "Arvada", "Westminster", "Pueblo", "Centennial"],
  Connecticut: ["Bridgeport", "Stamford", "New Haven", "Hartford", "Waterbury", "Norwalk", "Danbury", "New Britain", "West Hartford", "Greenwich"],
  Delaware: ["Wilmington", "Dover", "Newark", "Middletown", "Smyrna", "Milford", "Seaford", "Georgetown", "Elsmere", "New Castle"],
  Florida: ["Jacksonville", "Miami", "Tampa", "Orlando", "St. Petersburg", "Hialeah", "Port St. Lucie", "Cape Coral", "Tallahassee", "Fort Lauderdale"],
  Georgia: ["Atlanta", "Columbus", "Augusta", "Macon", "Savannah", "Athens", "Sandy Springs", "South Fulton", "Roswell", "Johns Creek"],
  Idaho: ["Boise", "Meridian", "Nampa", "Idaho Falls", "Caldwell", "Pocatello", "Coeur d'Alene", "Twin Falls", "Post Falls", "Lewiston"],
  Illinois: ["Chicago", "Aurora", "Joliet", "Naperville", "Rockford", "Springfield", "Elgin", "Peoria", "Champaign", "Waukegan"],
  Indiana: ["Indianapolis", "Fort Wayne", "Evansville", "South Bend", "Carmel", "Fishers", "Bloomington", "Hammond", "Gary", "Lafayette"],
  Iowa: ["Des Moines", "Cedar Rapids", "Davenport", "Sioux City", "Iowa City", "Waterloo", "Ames", "West Des Moines", "Ankeny", "Council Bluffs"],
  Kansas: ["Wichita", "Overland Park", "Kansas City", "Olathe", "Topeka", "Lawrence", "Shawnee", "Manhattan", "Lenexa", "Salina"],
  Kentucky: ["Louisville", "Lexington", "Bowling Green", "Owensboro", "Covington", "Richmond", "Georgetown", "Florence", "Hopkinsville", "Nicholasville"],
  Louisiana: ["New Orleans", "Baton Rouge", "Shreveport", "Lafayette", "Lake Charles", "Kenner", "Bossier City", "Monroe", "Alexandria", "Houma"],
  Maine: ["Portland", "Lewiston", "Bangor", "South Portland", "Auburn", "Biddeford", "Sanford", "Saco", "Westbrook", "Augusta"],
  Maryland: ["Baltimore", "Columbia", "Germantown", "Silver Spring", "Waldorf", "Frederick", "Ellicott City", "Glen Burnie", "Gaithersburg", "Rockville"],
  Massachusetts: ["Boston", "Worcester", "Springfield", "Cambridge", "Lowell", "Brockton", "New Bedford", "Quincy", "Lynn", "Fall River"],
  Michigan: ["Detroit", "Grand Rapids", "Warren", "Sterling Heights", "Ann Arbor", "Lansing", "Dearborn", "Clinton Township", "Livonia", "Troy"],
  Minnesota: ["Minneapolis", "Saint Paul", "Rochester", "Duluth", "Bloomington", "Brooklyn Park", "Plymouth", "Woodbury", "Maple Grove", "St. Cloud"],
  Mississippi: ["Jackson", "Gulfport", "Southaven", "Biloxi", "Hattiesburg", "Olive Branch", "Tupelo", "Meridian", "Greenville", "Madison"],
  Missouri: ["Kansas City", "St. Louis", "Springfield", "Columbia", "Independence", "Lee's Summit", "O'Fallon", "St. Joseph", "St. Charles", "St. Peters"],
  Montana: ["Billings", "Missoula", "Great Falls", "Bozeman", "Butte", "Helena", "Kalispell", "Havre", "Anaconda", "Miles City"],
  Nebraska: ["Omaha", "Lincoln", "Bellevue", "Grand Island", "Kearney", "Fremont", "Hastings", "Norfolk", "North Platte", "Columbus"],
  Nevada: ["Las Vegas", "Henderson", "Reno", "North Las Vegas", "Sparks", "Carson City", "Fernley", "Elko", "Mesquite", "Boulder City"],
  "New Hampshire": ["Manchester", "Nashua", "Concord", "Derry", "Dover", "Rochester", "Salem", "Merrimack", "Hudson", "Londonderry"],
  "New Jersey": ["Newark", "Jersey City", "Paterson", "Elizabeth", "Lakewood", "Edison", "Woodbridge", "Toms River", "Hamilton", "Trenton"],
  "New Mexico": ["Albuquerque", "Las Cruces", "Rio Rancho", "Santa Fe", "Roswell", "Farmington", "Clovis", "Hobbs", "Alamogordo", "Carlsbad"],
  "New York": ["New York", "Buffalo", "Yonkers", "Rochester", "Syracuse", "Albany", "New Rochelle", "Mount Vernon", "Schenectady", "Utica"],
  "North Carolina": ["Charlotte", "Raleigh", "Greensboro", "Durham", "Winston-Salem", "Fayetteville", "Cary", "Wilmington", "High Point", "Concord"],
  "North Dakota": ["Fargo", "Bismarck", "Grand Forks", "Minot", "West Fargo", "Williston", "Dickinson", "Mandan", "Jamestown", "Wahpeton"],
  Ohio: ["Columbus", "Cleveland", "Cincinnati", "Toledo", "Akron", "Dayton", "Parma", "Canton", "Lorain", "Hamilton"],
  Oklahoma: ["Oklahoma City", "Tulsa", "Norman", "Broken Arrow", "Edmond", "Lawton", "Moore", "Midwest City", "Enid", "Stillwater"],
  Oregon: ["Portland", "Salem", "Eugene", "Gresham", "Hillsboro", "Bend", "Beaverton", "Medford", "Springfield", "Corvallis"],
  Pennsylvania: ["Philadelphia", "Pittsburgh", "Allentown", "Reading", "Erie", "Scranton", "Bethlehem", "Lancaster", "Harrisburg", "Altoona"],
  "Rhode Island": ["Providence", "Warwick", "Cranston", "Pawtucket", "East Providence", "Woonsocket", "Coventry", "Cumberland", "North Providence", "South Kingstown"],
  "South Carolina": ["Charleston", "Columbia", "North Charleston", "Mount Pleasant", "Rock Hill", "Greenville", "Summerville", "Goose Creek", "Sumter", "Hilton Head Island"],
  "South Dakota": ["Sioux Falls", "Rapid City", "Aberdeen", "Brookings", "Watertown", "Mitchell", "Yankton", "Pierre", "Huron", "Spearfish"],
  Tennessee: ["Nashville", "Memphis", "Knoxville", "Chattanooga", "Clarksville", "Murfreesboro", "Franklin", "Johnson City", "Jackson", "Hendersonville"],
  Texas: ["Houston", "San Antonio", "Dallas", "Austin", "Fort Worth", "El Paso", "Arlington", "Corpus Christi", "Plano", "Lubbock"],
  Utah: ["Salt Lake City", "West Valley City", "Provo", "West Jordan", "Orem", "Sandy", "Ogden", "St. George", "Layton", "South Jordan"],
  Vermont: ["Burlington", "South Burlington", "Rutland", "Essex Junction", "Barre", "Montpelier", "Winooski", "St. Albans", "Newport", "Brattleboro"],
  Virginia: ["Virginia Beach", "Chesapeake", "Arlington", "Richmond", "Newport News", "Alexandria", "Norfolk", "Hampton", "Roanoke", "Portsmouth"],
  Washington: ["Seattle", "Spokane", "Tacoma", "Vancouver", "Bellevue", "Kent", "Everett", "Renton", "Spokane Valley", "Federal Way"],
  "West Virginia": ["Charleston", "Huntington", "Morgantown", "Parkersburg", "Wheeling", "Weirton", "Fairmont", "Martinsburg", "Beckley", "Clarksburg"],
  Wisconsin: ["Milwaukee", "Madison", "Green Bay", "Kenosha", "Racine", "Appleton", "Waukesha", "Eau Claire", "Oshkosh", "Janesville"],
  Wyoming: ["Cheyenne", "Casper", "Gillette", "Laramie", "Rock Springs", "Sheridan", "Green River", "Evanston", "Riverton", "Cody"],
};

/** A state given as "Virginia", "virginia", "VA" or "va", as its full name; null when it is not one of the 48. */
export function normalizeStateName(state: string): string | null {
  const text = (state ?? "").trim();
  if (!text) return null;
  const byName = Object.keys(TOP_CITIES_BY_STATE).find((name) => name.toLowerCase() === text.toLowerCase());
  if (byName) return byName;
  const abbr = text.toUpperCase();
  return Object.keys(US_STATE_ABBREVIATIONS).find((name) => US_STATE_ABBREVIATIONS[name] === abbr) ?? null;
}

/** The state's biggest cities as "City, State" (full state name, as Facebook's location box keeps it), biggest first; null for a state not in the table. */
export function topCitiesForState(state: string, count = 10): string[] | null {
  const name = normalizeStateName(state);
  const cities = name ? TOP_CITIES_BY_STATE[name] : undefined;
  return cities ? cities.slice(0, Math.max(1, count)).map((city) => `${city}, ${name}`) : null;
}
