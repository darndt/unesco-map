require "cgi"
require "json"
require "uri"
require_relative "db"
require_relative "http"

module Importers
  RAW = File.join(DB::ROOT, "data", "raw")

  def self.cached(name, refresh: ENV["REFRESH"])
    path = File.join(RAW, name)
    return File.read(path) if File.exist?(path) && !refresh
    FileUtils.mkdir_p(RAW)
    body = yield
    File.write(path, body)
    body
  end

  STOP = %w[of the and in at de la le les du des del di da y et a an on its with from to].freeze
  # Words too generic to identify a site on their own.
  GENERIC = %w[old city town historic historical centre center site sites national park archaeological
               monuments monument ensemble area areas cultural landscape group complex ruins].freeze

  def self.words(text)
    text.to_s.unicode_normalize(:nfkd).gsub(/\p{Mn}/, "").downcase
        .gsub(/\(.*?\)/, " ").gsub(/[^a-z0-9 ]/, " ").split - STOP
  end

  def self.trigrams(words)
    s = " #{words.join(' ')} "
    (0..s.length - 3).map { |i| s[i, 3] }.uniq
  end

  # How well an article title fits a site name, 0..1. Takes the best of:
  # word overlap, share of the title's distinctive words found in the name
  # ("Old City of Dubrovnik" → "Dubrovnik"), and character trigrams for
  # spelling variants ("Aksum" ~ "Axum", "Cuzco" ~ "Cusco").
  def self.similarity(name, title)
    x, y = words(name), words(title)
    return 0.0 if x.empty? || y.empty?
    jaccard = (x & y).size.to_f / (x | y).size
    distinctive = y - GENERIC
    contained = distinctive.empty? ? 0.0 : (distinctive & x).size.to_f / distinctive.size * 0.85
    tx, ty = trigrams(x), trigrams(y)
    dice = 2.0 * (tx & ty).size / (tx.size + ty.size)
    [jaccard, contained, dice].max
  end

  # Overview/list pages are not articles about one site.
  def self.useful_title(title)
    title unless title =~ /\A(List of|World Heritage)/i
  end

  def self.title_from_url(url)
    URI.decode_uri_component(url.split("/wiki/").last).tr("_", " ")
  end

  # ---------------------------------------------------------------- UNESCO
  module Unesco
    URL = "https://data.unesco.org/api/explore/v2.1/catalog/datasets/whc001/exports/json"

    def self.run
      puts "UNESCO: downloading official list (cached in data/raw)…"
      records = JSON.parse(Importers.cached("unesco.json") { HTTP.get(URL) })
      sites = DB.connection[:sites]
      count = 0
      DB.connection.transaction do
        records.each do |r|
          next if r["date_end"]                     # delisted sites
          id = r["id_no"].to_s[/\d+/]&.to_i
          point = r["geo_point_2d"]
          next unless id && point

          row = {
            name: clean(r["name_en"]),
            category: r["category"],
            danger: r["danger"].to_s == "True",
            year_inscribed: r["date_inscribed"].to_s[/\d{4}/]&.to_i,
            countries: Array(r["states_names"]).join(", "),
            iso_codes: Array(r["iso_codes"]).join(","),
            region: r["region"],
            lat: point["lat"], lon: point["lon"],
            transboundary: r["transboundary"].to_s == "True",
            criteria: r["criteria_txt"],
            area_hectares: r["area_hectares"],
            unesco_summary: clean(r["short_description_en"]),
            unesco_image_url: r["main_image_url"],
            unesco_image_credit: r["main_image_copyright"] || r["main_image_author"],
            updated_at: Time.now
          }
          if sites.where(id_no: id).update(row).zero?
            sites.insert(row.merge(id_no: id))
          end
          count += 1
        end
      end
      puts "UNESCO: #{count} inscribed sites stored."
    end

    def self.clean(text)
      return nil if text.nil?
      CGI.unescapeHTML(text.gsub(/<[^>]+>/, " ")).gsub(/\s+/, " ").strip
    end
  end

  # -------------------------------------------------------------- Wikidata
  # P757 = World Heritage Site ID. Many items carry the same base number
  # (component parts like "1004-003", extensions like "1000rev", or the city
  # that contains the site), so every candidate gets a score and the best wins.
  module Wikidata
    ENDPOINT = "https://query.wikidata.org/sparql"
    QUERY = <<~SPARQL
      SELECT ?item ?whs ?image ?article ?sitelinks ?isWHS WHERE {
        ?item wdt:P757 ?whs ;
              wikibase:sitelinks ?sitelinks .
        OPTIONAL { ?item wdt:P18 ?image }
        OPTIONAL { ?article schema:about ?item ;
                            schema:isPartOf <https://en.wikipedia.org/> }
        BIND(EXISTS { ?item wdt:P1435 wd:Q9259 } AS ?isWHS)
      }
    SPARQL

    def self.run
      puts "Wikidata: querying P757 links…"
      body = Importers.cached("wikidata.json") do
        HTTP.get(ENDPOINT, params: { query: QUERY },
                           headers: { "Accept" => "application/sparql-results+json" })
      end
      rows = JSON.parse(body).dig("results", "bindings")

      cands = Hash.new { |h, k| h[k] = [] }
      rows.each do |b|
        raw = b.dig("whs", "value").to_s.strip.downcase
        m = raw.match(/\A0*(\d+)([a-z]*)(?:-(\d+))?\z/) or next
        cands[m[1].to_i] << {
          qid: b.dig("item", "value").split("/").last,
          article: b["article"] && Importers.useful_title(Importers.title_from_url(b.dig("article", "value"))),
          image: b["image"] && URI.decode_uri_component(b.dig("image", "value").split("Special:FilePath/").last),
          whole: m[3].nil?,
          sitelinks: b.dig("sitelinks", "value").to_i,
          score: score(m, b)
        }
      end

      sites = DB.connection[:sites]
      matched = 0
      DB.connection.transaction do
        sites.select(:id_no, :name).each do |s|
          list = cands[s[:id_no]]
          next if list.empty?
          best = list.max_by { |c| c[:score] }
          # Article: only from items describing the whole site. Articles of component
          # parts (e.g. one temple of Angkor) are kept as fallbacks for the search step.
          article = best[:article] || list.select { |c| c[:whole] && c[:article] }
                                          .max_by { |c| Importers.similarity(s[:name], c[:article]) }&.fetch(:article)
          fallbacks = list.reject { |c| c[:whole] }.filter_map { |c| c[:article] }.uniq
          image = best[:image] || list.select { |c| c[:image] }.max_by { |c| [c[:whole] ? 1 : 0, c[:sitelinks]] }&.fetch(:image)
          row = sites.where(id_no: s[:id_no])
          if row.get(:wikipedia_title) != article          # article changed: drop its old text/image
            row.update(wikipedia_extract: nil, wikipedia_thumb: nil)
          end
          row.update(wikidata_id: best[:qid], wikipedia_title: article,
                     wikipedia_fallbacks: JSON.generate(fallbacks), commons_image: image)
          matched += 1
        end
      end
      puts "Wikidata: matched #{matched} of #{sites.count} sites, #{sites.exclude(wikipedia_title: nil).count} with an English article."
    end

    def self.score(m, b)
      s = 0
      s += 1000 if m[3].nil?                                    # whole site, not a component
      s += 500  if m[2].empty?                                  # no bis/rev/ter suffix
      s += 300  if b.dig("isWHS", "value") == "true"            # item is designated WHS
      s += 200  if b["article"]                                 # has English article
      s += 50   if b["image"]
      s + [b.dig("sitelinks", "value").to_i, 49].min
    end
  end

  # ------------------------------------------------------------- Wikipedia
  # Lead section text (as context for the description) and the article's lead image.
  module Wikipedia
    API = "https://en.wikipedia.org/w/api.php"

    def self.run
      search_missing
      sites = DB.connection[:sites]
      todo = sites.exclude(wikipedia_title: nil)
      todo = todo.where(wikipedia_extract: nil) unless ENV["REFRESH"]
      titles = todo.select_map(:wikipedia_title).uniq
      puts "Wikipedia: fetching intros for #{titles.size} articles…"

      titles.each_slice(20).with_index do |batch, i|
        data = HTTP.get_json(API, params: {
          action: "query", format: "json", formatversion: 2, redirects: 1,
          prop: "extracts|pageimages", exintro: 1, explaintext: 1, exlimit: 20,
          piprop: "thumbnail", pithumbsize: 800, pilimit: 20,
          titles: batch.join("|")
        })
        q = data["query"] || {}
        back = {}
        (q["normalized"] || []).each { |n| back[n["to"]] = n["from"] }
        (q["redirects"]  || []).each { |r| back[r["to"]] = back[r["from"]] || r["from"] }

        DB.connection.transaction do
          (q["pages"] || []).each do |page|
            next if page["missing"]
            original = back[page["title"]] || page["title"]
            extract = page["extract"].to_s.strip
            update = { wikipedia_extract: extract.empty? ? nil : extract[0, 2500] }
            update[:wikipedia_thumb] = page.dig("thumbnail", "source")
            sites.where(wikipedia_title: original).update(update)
          end
        end
        print "." if (i % 5).zero?
        sleep 1.5
      end
      puts
      choose_images
    end

    # For sites Wikidata could not link to a whole-site article: search Wikipedia
    # by name and take the best-fitting title; fall back to a component article.
    def self.search_missing
      sites = DB.connection[:sites]
      missing = sites.where(wikipedia_title: nil).select(:id_no, :name, :wikipedia_fallbacks).all
      return if missing.empty?
      cache_path = File.join(RAW, "wikipedia_search.json")
      cache = File.exist?(cache_path) ? JSON.parse(File.read(cache_path)) : {}
      puts "Wikipedia: searching articles for #{missing.size} sites without a whole-site link…"
      from_search = from_component = 0
      missing.each_with_index do |s, i|
        hits = cache[s[:name]] ||= begin
          sleep 0.7
          (HTTP.get_json(API, params: {
            action: "query", format: "json", formatversion: 2, list: "search",
            srsearch: s[:name], srlimit: 5, srprop: ""
          }).dig("query", "search") || []).map { |h| h["title"] }
        end
        File.write(cache_path, JSON.generate(cache)) if (i % 10).zero?

        hit = hits.select { |t| Importers.useful_title(t) }.max_by { |t| Importers.similarity(s[:name], t) }
        fallbacks = JSON.parse(s[:wikipedia_fallbacks] || "[]")
        comp = fallbacks.max_by { |t| Importers.similarity(s[:name], t) }
        title =
          if hit && Importers.similarity(s[:name], hit) >= 0.4 then from_search += 1; hit
          elsif comp then from_component += 1; comp
          end
        sites.where(id_no: s[:id_no]).update(wikipedia_title: title, wikipedia_extract: nil, wikipedia_thumb: nil) if title
      end
      File.write(cache_path, JSON.generate(cache))
      puts "Wikipedia: linked #{from_search} via search, #{from_component} via a component article."
    end

    # Preference: Wikidata P18 (a curated photo of the site) → Wikipedia lead
    # image (sometimes a map) → UNESCO photo.
    def self.choose_images
      sites = DB.connection[:sites]
      sites.where(wikipedia_title: nil).update(wikipedia_extract: nil, wikipedia_thumb: nil)
      sites.all.each do |s|
        if s[:commons_image]
          enc = URI.encode_www_form_component(s[:commons_image].tr(" ", "_"))
          url  = "https://commons.wikimedia.org/wiki/Special:FilePath/#{enc}?width=800"
          page = "https://commons.wikimedia.org/wiki/File:#{enc}"
        elsif s[:wikipedia_thumb]
          url = s[:wikipedia_thumb].sub(/\?.*\z/, "")
          file = url.include?("/thumb/") ? url.split("/")[-2] : url.split("/").last
          page = "https://commons.wikimedia.org/wiki/File:#{file}"
        elsif s[:unesco_image_url]
          url  = s[:unesco_image_url]
          page = "https://whc.unesco.org/en/list/#{s[:id_no]}/gallery/"
        end
        sites.where(id_no: s[:id_no]).update(image_url: url, image_page_url: page)
      end
      puts "Images: #{sites.exclude(image_url: nil).count} of #{sites.count} sites have a picture."
    end

    def self.wiki_url(title)
      "https://en.wikipedia.org/wiki/#{URI.encode_www_form_component(title.tr(' ', '_')).gsub('%2F', '/').gsub('%3A', ':')}"
    end
  end
end
