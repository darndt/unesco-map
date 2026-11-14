require "net/http"
require "uri"
require "json"

module HTTP
  USER_AGENT = "unesco-heritage-map/1.0 (personal, non-commercial map; Ruby Net::HTTP)"

  def self.get(url, params: {}, headers: {}, retries: 6)
    uri = URI(url)
    uri.query = URI.encode_www_form(params) unless params.empty?
    attempt = 0
    begin
      attempt += 1
      req = Net::HTTP::Get.new(uri)
      req["User-Agent"] = USER_AGENT
      headers.each { |k, v| req[k] = v }
      res = Net::HTTP.start(uri.host, uri.port, use_ssl: uri.scheme == "https",
                            open_timeout: 20, read_timeout: 180) { |http| http.request(req) }
      case res
      when Net::HTTPSuccess then res.body.force_encoding("UTF-8")
      when Net::HTTPTooManyRequests, Net::HTTPServerError
        @retry_after = res["Retry-After"].to_i
        raise "HTTP #{res.code} for #{uri.host}"
      else
        raise ArgumentError, "HTTP #{res.code} for #{uri}"
      end
    rescue ArgumentError
      raise
    rescue StandardError => e
      raise if attempt > retries
      wait = [2**(attempt + 1), @retry_after.to_i].max
      @retry_after = nil
      warn "  #{e.message} — retrying in #{wait}s"
      sleep wait
      retry
    end
  end

  def self.get_json(url, **opts)
    JSON.parse(get(url, **opts))
  end
end
